const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const axios = require('axios');

// Root directory is one level up from src
const ROOT_DIR = path.join(__dirname, '..');
const OUTPUTS_DIR = path.join(ROOT_DIR, 'outputs');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

// Global browser instance
let globalBrowser = null;
let browserOperationInProgress = false;
let browserOperationStartTime = null;
const BROWSER_OPERATION_TIMEOUT_MS = 30 * 1000; // 30 seconds timeout for browser operations

// Initialize browser with retry logic
async function initBrowser(retryCount = 3) {
  for (let i = 0; i < retryCount; i++) {
    try {
      console.log(`Browser initialization attempt ${i + 1}/${retryCount}`);
      
      if (globalBrowser) {
        console.log('Closing existing browser instance');
        await globalBrowser.close().catch(console.error);
        globalBrowser = null;
      }
      
      // Simple, minimal browser launch options similar to court_proxy_app
      globalBrowser = await firefox.launch({
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process'
        ],
        timeout: 30000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false
      });
      
      // Verify browser health
      const testContext = await globalBrowser.newContext();
      await testContext.close();
      
      console.log('Browser initialization successful');
      return globalBrowser;
    } catch (error) {
      console.error(`Browser initialization attempt ${i + 1} failed:`, error);
      if (i === retryCount - 1) {
        throw new Error(`Failed to initialize browser after ${retryCount} attempts: ${error.message}`);
      }
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Add browser operation lock function
async function withBrowserLock(operation) {
  if (browserOperationInProgress) {
    // Check if the current operation has timed out
    const operationTimeMs = Date.now() - browserOperationStartTime;
    if (operationTimeMs > BROWSER_OPERATION_TIMEOUT_MS) {
      console.log(`Browser operation timed out after ${Math.round(operationTimeMs/1000)} seconds, forcing reset`);
      browserOperationInProgress = false;
      // Force garbage collection if available
      if (global.gc) {
        console.log('Forcing garbage collection after operation timeout');
        global.gc();
      }
    } else {
      console.log(`Browser operation already in progress for ${Math.round(operationTimeMs/1000)} seconds, waiting...`);
      return null; // Return null to indicate operation was skipped
    }
  }
  
  try {
    browserOperationInProgress = true;
    browserOperationStartTime = Date.now();
    return await operation();
  } finally {
    browserOperationInProgress = false;
    // Force garbage collection if available
    if (global.gc) {
      console.log('Forcing garbage collection after browser operation');
      global.gc();
    }
  }
}

// Enhanced helper function to implement retry logic with exponential backoff
async function retry(fn, maxRetries = 3, initialDelay = 5000, maxDelay = 60000, finalError = null) {
  let retries = 0;
  let delay = initialDelay;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      if (retries > maxRetries) {
        throw finalError || error;
      }
      
      // Apply exponential backoff with jitter
      const jitter = Math.random() * 1000;
      delay = Math.min(delay * 1.5 + jitter, maxDelay);
      
      console.log(`Attempt ${retries} failed, retrying in ${Math.round(delay/1000)} seconds... (${maxRetries - retries + 1} retries left)`);
      console.log(`Error was: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Safety timeout to detect hanging processes
function setupSafetyTimeout(timeoutMs = 30000) {
  console.log(`Setting up safety timeout for ${timeoutMs/1000} seconds`);
  return setTimeout(() => {
    console.error(`SAFETY TIMEOUT TRIGGERED after ${timeoutMs/1000} seconds - process appears to be hanging`);
    process.exit(1); // Force exit if we detect a hang
  }, timeoutMs);
}

// Create a unique run folder for all outputs
function createRunFolder() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  // Create base outputs directory if it doesn't exist
  if (!fs.existsSync(OUTPUTS_DIR)) {
    fs.mkdirSync(OUTPUTS_DIR);
  }
  
  // Create a unique folder for this run
  const runFolder = path.join(OUTPUTS_DIR, `run-${timestamp}`);
  fs.mkdirSync(runFolder);
  
  console.log(`Created output folder for this run: ${runFolder}`);
  return runFolder;
}

function logDetailedMemoryUsage() {
  const memUsage = process.memoryUsage();
  console.log('Memory Usage:');
  for (const [key, value] of Object.entries(memUsage)) {
    console.log(`  ${key}: ${Math.round(value / 1024 / 1024 * 100) / 100} MB`);
  }
}

// Create a dedicated network request logger
function setupNetworkLogging(page, runFolder) {
  const networkLogPath = path.join(runFolder, 'network_log.json');
  const networkEvents = [];
  
  // Helper function to log network events
  const logNetworkEvent = (type, data) => {
    const event = {
      timestamp: new Date().toISOString(),
      type,
      ...data
    };
    networkEvents.push(event);
    
    // Write to log file periodically
    fs.writeFileSync(networkLogPath, JSON.stringify(networkEvents, null, 2));
    
    // Log to console for critical events
    if (['request_failed', 'response_error'].includes(type)) {
      console.log(`Network ${type}:`, JSON.stringify(data));
    }
  };
  
  // Setup event listeners
  page.on('request', request => {
    logNetworkEvent('request_sent', { 
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      resourceType: request.resourceType()
    });
  });
  
  page.on('requestfailed', request => {
    logNetworkEvent('request_failed', { 
      url: request.url(),
      method: request.method(),
      failureText: request.failure()?.errorText || 'Unknown failure',
      resourceType: request.resourceType()
    });
  });
  
  page.on('response', response => {
    const status = response.status();
    const data = {
      url: response.url(),
      status,
      statusText: response.statusText(),
      headers: response.headers(),
      resourceType: response.request().resourceType()
    };
    
    // Flag error responses
    if (status >= 400) {
      logNetworkEvent('response_error', data);
    } else {
      logNetworkEvent('response_received', data);
    }
  });
  
  return {
    getNetworkEvents: () => networkEvents,
    logNetworkSummary: () => {
      // Count events by type and status
      const summary = {
        totalRequests: networkEvents.filter(e => e.type === 'request_sent').length,
        failedRequests: networkEvents.filter(e => e.type === 'request_failed').length,
        errorResponses: networkEvents.filter(e => e.type === 'response_error').length,
        successfulResponses: networkEvents.filter(e => 
          e.type === 'response_received' && e.status < 400).length
      };
      
      console.log('Network activity summary:', summary);
      return summary;
    }
  };
}

// Helper to log screenshot URLs
function logScreenshotUrl(runFolder, filename) {
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://military-search-server-production.up.railway.app';
  const url = `${baseUrl}/screenshots/${runFolder}/${filename}`;
  console.log(`Screenshot available at: ${url}`);
}

async function runScraAutomation({
  ssn,
  dob,
  lastName,
  firstName,
  scraUsername,
  scraPassword,
  matterId,
  endpointUrl
}) {
  // Set a safety timeout to catch hangs
  let safetyTimeout = setupSafetyTimeout(30000); // 30 seconds
  
  // Create a unique folder for this run's outputs
  const runFolder = createRunFolder();
  let screenshotIndex = 1;
  function nextScreenshotName(base) {
    return `${String(screenshotIndex++).padStart(2, '0')}_${base}`;
  }

  console.log('Running SCRA automation with:', {
    ssn: ssn ? `***-**-${ssn.replace(/\D/g, '').slice(-4)}` : 'MISSING',
    dob: dob ? 'PROVIDED' : 'NOT PROVIDED',
    lastName,
    firstName,
    matterId,
    endpointUrl: endpointUrl ? `${endpointUrl.substring(0, 15)}...` : 'NONE'
  });

  const SCRA_URL = 'https://scra.dmdc.osd.mil/scra/#/single-record';
  let browser = null;
  let networkLogger;
  
  try {
    console.log('Initializing browser...');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR);
    }
    
    // Initialize browser using the locked operation and retry logic
    browser = await withBrowserLock(() => initBrowser(3));
    if (!browser) {
      throw new Error('Could not get browser lock - another browser operation is in progress');
    }
    
    console.log('Browser initialized successfully. Creating browser context...');
    // Take screenshot of system state after browser initialization
    fs.writeFileSync(path.join(runFolder, nextScreenshotName('screenshot_after_browser_init.png')), 
                    Buffer.from('Browser initialized - no visual yet', 'utf8'));
    logDetailedMemoryUsage();
    
    // Use common user agents that are less likely to be blocked
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15'
    ];
    
    // Select a random user agent
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    console.log(`Using user agent: ${userAgent}`);
    
    // Create context with timeout
    const contextPromise = browser.newContext({ 
      viewport: { width: 1920, height: 1080 },
      userAgent
    });
    
    // Add timeout to context creation
    const context = await Promise.race([
      contextPromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Context creation timed out after 10 seconds')), 10000)
      )
    ]);
    
    console.log('Browser context created. Creating new page...');
    // Take screenshot of system state after context creation
    fs.writeFileSync(path.join(runFolder, nextScreenshotName('screenshot_after_context_creation.png')), 
                    Buffer.from('Context created - no visual yet', 'utf8'));
    
    // Create page with timeout
    const pagePromise = context.newPage();
    const page = await Promise.race([
      pagePromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Page creation timed out after 10 seconds')), 10000)
      )
    ]);
    
    console.log('Page created successfully.');
    // Take screenshot of system state after page creation
    fs.writeFileSync(path.join(runFolder, nextScreenshotName('screenshot_after_page_creation.png')), 
                    Buffer.from('Page created - no visual yet', 'utf8'));
    
    // Reset the safety timeout now that we've gotten past the critical initialization stage
    if (safetyTimeout) {
      clearTimeout(safetyTimeout);
      console.log('Initial safety timeout cleared, setting new longer timeout');
      
      // Set a longer safety timeout for the rest of the process
      const extendedTimeout = setupSafetyTimeout(120000); // 2 minutes
      
      // Remember to clear this before returning
      safetyTimeout = extendedTimeout;
    }
    
    // Set up network logger
    networkLogger = setupNetworkLogging(page, runFolder);
    
    // Simplified navigation with direct error handling
    try {
      // Connectivity check: navigate to Google to confirm Internet access
      console.log('Connectivity check: navigating to Google');
      await page.goto('https://www.google.com', { timeout: 60000, waitUntil: 'domcontentloaded' });
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_google_connectivity.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_google_connectivity.png'));
      console.log('Connectivity test completed successfully');
      console.log(`Navigating to SCRA URL: ${SCRA_URL}`);
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_before_navigation.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_before_navigation.png'));
      // Retry navigation up to 3 times in case of transient issues
      await retry(() => page.goto(SCRA_URL, { timeout: 60000, waitUntil: 'domcontentloaded' }), 3, 1000, 60000, new Error('Failed to navigate to SCRA site after 3 attempts'));
      console.log(`Successfully loaded page: ${await page.title()}`);
      // Take screenshot for verification
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_nav.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_nav.png'));
      console.log('Screenshot taken after navigation.');
    } catch (navError) {
      console.error('Navigation error:', navError);
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_nav_error.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_nav_error.png'));
      throw new Error(`Failed to navigate to SCRA site: ${navError.message}`);
    }

    // Handle Privacy Act confirmation modal if present
    try {
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_before_privacy_modal.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_before_privacy_modal.png'));
      const privacyAcceptBtn = await page.$('button[title="I Accept"]');
      if (privacyAcceptBtn) {
        console.log('Privacy confirmation modal detected. Clicking Accept...');
        await privacyAcceptBtn.click();
        await page.waitForTimeout(500); // Small delay to allow modal to close
        await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_privacy_modal.png')) });
        logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_privacy_modal.png'));
      } else {
        console.log('No privacy confirmation modal detected.');
      }
    } catch (modalError) {
      console.log('Error handling privacy modal:', modalError.message);
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_privacy_modal_error.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_privacy_modal_error.png'));
      // Continue even if modal handling fails - it might not be present
    }

    // Check for login form
    await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_before_login_check.png')) });
    logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_before_login_check.png'));
    if (await page.$('input#username')) {
      console.log('Login form detected, logging in...');
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_login_form_found.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_login_form_found.png'));
      try {
        await page.fill('input#username', scraUsername);
        await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_username_filled.png')) });
        logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_username_filled.png'));
        await page.fill('input#password', scraPassword);
        await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_password_filled.png')) });
        logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_password_filled.png'));
        
        console.log('Submitting login credentials...');
        await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_before_login_submit.png')) });
        logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_before_login_submit.png'));
        await Promise.all([
          page.click("button[type='submit']"),
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 })
        ]);
        console.log('Logged in successfully');
        await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_login.png')) });
        logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_login.png'));
      } catch (loginError) {
        console.error('Error during login:', loginError.message);
        await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_login_error.png')) });
        logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_login_error.png'));
        throw new Error(`Login failed: ${loginError.message}`);
      }
    } else {
      console.log('No login form detected, continuing...');
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_no_login_form.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_no_login_form.png'));
    }

    // Give the page a moment to stabilize after login
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_stabilization.png')) });
    logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_stabilization.png'));

    // Fill out the form fields
    await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_before_form_filling.png')) });
    logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_before_form_filling.png'));
    // Clean SSN to ensure only digits are submitted
    const cleanedSsn = ssn.replace(/\D/g, '');
    console.log('Filling out SSN...');
    await page.fill('#ssnInput', cleanedSsn);
    await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_ssn_filled.png')) });
    logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_ssn_filled.png'));
    await page.fill('#ssnConfirmationInput', cleanedSsn);
    await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_ssn_confirmation_filled.png')) });
    logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_ssn_confirmation_filled.png'));
    console.log('Filling out Last Name...');
    await page.fill('#lastNameInput', lastName);
    await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_lastname_filled.png')) });
    logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_lastname_filled.png'));
    console.log('Filling out First Name...');
    await page.fill('#firstNameInput', firstName);
    await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_firstname_filled.png')) });
    logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_firstname_filled.png'));
    if (dob) {
      console.log('Filling out Date of Birth...');
      await page.fill('#mat-input-2', dob); // Format: MM/DD/YYYY
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_dob_filled.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_dob_filled.png'));
    }
    await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_form_completed.png')) });
    logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_form_completed.png'));

    // Accept terms
    console.log('Waiting for I Accept checkbox to be attached...');
    const checkboxSelector = 'input[name="termsAgree"]';
    const labelSelector = 'label[for="mat-mdc-checkbox-7-input"]';
    let checkboxFound = false;
    
    try {
      // Wait longer for the checkbox to appear
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_before_checkbox_wait.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_before_checkbox_wait.png'));
      await page.waitForSelector(checkboxSelector, { state: 'attached', timeout: 20000 });
      await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_before_checkbox.png')) });
      logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_before_checkbox.png'));
      console.log('Screenshot taken before attempting to check I Accept checkbox.');
      
      try {
        await page.check(checkboxSelector);
        checkboxFound = true;
        console.log('Checked the checkbox using input[name="termsAgree"]');
        await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_checkbox.png')) });
        logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_checkbox.png'));
      } catch (e) {
        console.log('Primary check failed, trying to click the label as fallback...', e.message);
        await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_checkbox_primary_failed.png')) });
        logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_checkbox_primary_failed.png'));
        try {
          await page.click(labelSelector);
          checkboxFound = true;
          console.log('Checked the checkbox by clicking the label.');
          await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_checkbox_label_click.png')) });
          logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_checkbox_label_click.png'));
        } catch (e2) {
          console.log('Fallback label click also failed.', e2.message);
          await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_checkbox_label_failed.png')) });
          logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_checkbox_label_failed.png'));
          
          // Try a more general approach
          console.log('Trying alternative checkbox methods...');
          const checkboxes = await page.$$('input[type="checkbox"]');
          if (checkboxes.length > 0) {
            console.log(`Found ${checkboxes.length} checkboxes, trying to click each...`);
            for (const checkbox of checkboxes) {
              try {
                await checkbox.check();
                checkboxFound = true;
                console.log('Successfully checked a checkbox using alternative method');
                await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_checkbox_alternative.png')) });
                logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_checkbox_alternative.png'));
                break;
              } catch (e3) {
                console.log('Failed to check checkbox, trying next...');
              }
            }
          }
        }
      }
      
      if (checkboxFound) {
        // Submit the form
        console.log('Clicking Submit button...');
        await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_before_submit.png')) });
        logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_before_submit.png'));
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const pdfPath = path.join(runFolder, `scra-result.pdf`);
        
        try {
          // Use a longer timeout for the download
          const [ download ] = await Promise.all([
            page.waitForEvent('download', { timeout: 45000 }),
            page.click('button[name="SubmitButton"]'),
          ]);
          
          console.log('Download started, waiting for completion...');
          await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_download_started.png')) });
          logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_download_started.png'));
          await download.saveAs(pdfPath);
          console.log(`PDF downloaded and saved to: ${pdfPath}`);
          await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_download.png')) });
          logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_download.png'));

          // Parse the PDF to determine proofOfMilitaryServiceFound
          const fileData = fs.readFileSync(pdfPath);
          const pdfData = await pdfParse(fileData);
          const pdfText = pdfData.text;
          
          console.log('PDF parsed, analyzing content');
          await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_pdf_parsing.png')) });
          logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_pdf_parsing.png'));
          
          // Simple heuristic: look for any value in the relevant sections that is not 'NA' or 'No'
          let proofOfMilitaryServiceFound = 'No';
          const lines = pdfText.split(/\r?\n/);
          let inTable = false;
          
          for (const line of lines) {
            if (/Start Date/i.test(line)) inTable = true;
            if (inTable && /Service Component/i.test(line)) inTable = false;
            if (inTable) {
              if (!/\b(NA|No)\b/i.test(line) && /\w/.test(line)) {
                proofOfMilitaryServiceFound = 'Yes';
                break;
              }
            }
          }
          console.log(`proofOfMilitaryServiceFound: ${proofOfMilitaryServiceFound}`);
          
          // Rename the file according to the specified naming conventions
          let finalPdfName;
          if (proofOfMilitaryServiceFound === 'No') {
            finalPdfName = 'AFFIRMATION - Affirmation of Non Military.pdf';
          } else {
            finalPdfName = `${firstName} ${lastName} - Proof of Military Service.pdf`;
          }
          
          // Create the renamed file path
          const finalPdfPath = path.join(runFolder, finalPdfName);
          
          // Rename the file
          fs.renameSync(pdfPath, finalPdfPath);
          console.log(`PDF renamed to: ${finalPdfName}`);
          
          // Save the result to a JSON file for reference
          fs.writeFileSync(
            path.join(runFolder, 'result.json'), 
            JSON.stringify({ 
              matterId,
              proofOfMilitaryServiceFound,
              pdfFileName: finalPdfName,
              timestamp: new Date().toISOString()
            }, null, 2)
          );
          await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_before_callback.png')) });
          logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_before_callback.png'));

          // POST to endpoint if provided
          if (endpointUrl) {
            try {
              console.log(`Sending results to callback URL: ${endpointUrl.substring(0, 30)}...`);
              
              // Read the renamed PDF file
              const pdfFileData = fs.readFileSync(finalPdfPath);
              
              // Create payload with field names matching exactly what the Salesforce handler expects
              const sfPayload = {
                matterId: matterId,
                proofOfMilitaryServiceFound: proofOfMilitaryServiceFound,
                pdfBase64: pdfFileData.toString('base64')
              };
              
              // Debug the payload size
              console.log(`Payload size: ~${Math.round(JSON.stringify(sfPayload).length / 1024)} KB`);
              
              console.log('Sending request with field names matching Salesforce handler...');
              const postResp = await axios.post(endpointUrl, sfPayload, {
                headers: { 
                  'Content-Type': 'application/json',
                  'Accept': 'application/json'
                },
                timeout: 60000 // 60 second timeout for the callback
              });
              
              console.log(`POST to endpoint succeeded: ${postResp.status} ${postResp.statusText}`);
              await page.screenshot({ path: path.join(runFolder, nextScreenshotName('screenshot_after_callback.png')) });
              logScreenshotUrl(path.basename(runFolder), nextScreenshotName('screenshot_after_callback.png'));
              
              // Check if response contains HTML instead of JSON
              const isHtmlResponse = 
                typeof postResp.data === 'string' && 
                (postResp.data.includes('<!DOCTYPE HTML') || postResp.data.includes('<html'));
              
              if (isHtmlResponse) {
                console.warn('Warning: Received HTML response from Salesforce endpoint instead of JSON.');
                console.warn('This usually indicates that the endpoint is not correctly configured to receive API requests.');
                console.warn('Please check that the Salesforce Site is properly configured with a REST endpoint.');
              }
              
              // Save the response for debugging
              fs.writeFileSync(
                path.join(runFolder, 'callback_response.json'),
                JSON.stringify({
                  status: postResp.status,
                  statusText: postResp.statusText,
                  data: postResp.data,
                  isHtmlResponse
                }, null, 2)
              );
              
              // Save the exact request payload for debugging
              fs.writeFileSync(
                path.join(runFolder, 'callback_request.json'),
                JSON.stringify(sfPayload, null, 2)
              );
            } catch (err) {
              console.error('POST to endpoint failed:', err.response ? err.response.data : err.message);
              await page.screenshot({ path: path.join(runFolder, 'screenshot_callback_error.png') });
              logScreenshotUrl(path.basename(runFolder), 'screenshot_callback_error.png');
              
              // Save error information
              fs.writeFileSync(
                path.join(runFolder, 'callback_error.json'),
                JSON.stringify({
                  message: err.message,
                  response: err.response ? {
                    status: err.response.status,
                    data: err.response.data
                  } : null,
                  endpoint: endpointUrl
                }, null, 2)
              );
              
              throw new Error(`Failed to send results: ${err.message}`);
            }
          } else {
            console.log('No endpoint URL provided, skipping results submission');
          }
        } catch (downloadError) {
          console.error('Error during form submission or download:', downloadError.message);
          await page.screenshot({ path: path.join(runFolder, 'screenshot_download_error.png') });
          logScreenshotUrl(path.basename(runFolder), 'screenshot_download_error.png');
          throw new Error(`Form submission failed: ${downloadError.message}`);
        }
      } else {
        await page.screenshot({ path: path.join(runFolder, 'screenshot_checkbox_not_found.png') });
        logScreenshotUrl(path.basename(runFolder), 'screenshot_checkbox_not_found.png');
        throw new Error('I Accept checkbox not found or not interactable after multiple attempts.');
      }
    } catch (checkboxError) {
      console.error('Error with checkbox handling:', checkboxError.message);
      await page.screenshot({ path: path.join(runFolder, 'screenshot_checkbox_error.png') });
      logScreenshotUrl(path.basename(runFolder), 'screenshot_checkbox_error.png');
      throw checkboxError;
    }
  } catch (err) {
    console.error('Error during SCRA automation:', err);
    if (browser) {
      try {
        const page = browser.contexts()[0]?.pages()[0];
        if (page) {
          await page.screenshot({ path: path.join(runFolder, 'screenshot_on_error.png') });
          console.log('Screenshot taken on error.');
          
          // Save network log summary if available
          if (networkLogger) {
            const summary = networkLogger.logNetworkSummary();
            fs.writeFileSync(
              path.join(runFolder, 'network_summary.json'),
              JSON.stringify(summary, null, 2)
            );
          }
        }
      } catch (screenshotErr) {
        console.error('Failed to take screenshot on error:', screenshotErr);
      }
    }
    
    // Create an error report with all details
    try {
      const errorReport = {
        timestamp: new Date().toISOString(),
        error: {
          message: err.message,
          stack: err.stack,
          name: err.name
        },
        context: {
          ssn: ssn ? '***-**-' + ssn.replace(/\D/g, '').slice(-4) : 'MISSING',
          dob: dob ? 'PROVIDED' : 'NOT PROVIDED',
          matterId,
          hasEndpointUrl: !!endpointUrl
        }
      };
      
      fs.writeFileSync(
        path.join(runFolder, 'error_report.json'),
        JSON.stringify(errorReport, null, 2)
      );
      
      // Also write to central error log
      const errorLogPath = path.join(LOGS_DIR, 'error_log.json');
      let errorLog = [];
      
      if (fs.existsSync(errorLogPath)) {
        try {
          errorLog = JSON.parse(fs.readFileSync(errorLogPath, 'utf8'));
        } catch (e) {
          console.error('Failed to parse existing error log:', e);
        }
      }
      
      errorLog.push(errorReport);
      
      // Keep only the last 100 errors
      if (errorLog.length > 100) {
        errorLog = errorLog.slice(-100);
      }
      
      fs.writeFileSync(errorLogPath, JSON.stringify(errorLog, null, 2));
      console.log('Error report saved');
      
    } catch (reportErr) {
      console.error('Failed to create error report:', reportErr);
    }
    
    throw err; // Re-throw the error for proper handling
  } finally {
    // Clear safety timeout to prevent unnecessary process termination
    if (safetyTimeout) {
      clearTimeout(safetyTimeout);
      console.log('Safety timeout cleared');
    }
    
    if (browser) {
      try {
        console.log('Closing browser...');
        await browser.close();
        console.log('Browser closed successfully');
      } catch (closeBrowserErr) {
        console.error('Error closing browser:', closeBrowserErr);
      }
    }
  }
}

module.exports = { runScraAutomation }; 