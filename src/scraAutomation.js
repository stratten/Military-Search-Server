const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const axios = require('axios');

// Root directory is one level up from src
const ROOT_DIR = path.join(__dirname, '..');
const OUTPUTS_DIR = path.join(ROOT_DIR, 'outputs');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

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
function setupSafetyTimeout(timeoutMs = 180000) {
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
  const safetyTimeout = setupSafetyTimeout(300000); // 5 minutes
  
  // Create a unique folder for this run's outputs
  const runFolder = createRunFolder();
  
  console.log('Running SCRA automation with:', {
    ssn: ssn ? `***-**-${ssn.replace(/\D/g, '').slice(-4)}` : 'MISSING',
    dob: dob ? 'PROVIDED' : 'NOT PROVIDED',
    lastName,
    firstName,
    matterId,
    endpointUrl: endpointUrl ? `${endpointUrl.substring(0, 15)}...` : 'NONE'
  });

  const SCRA_URL = 'https://scra.dmdc.osd.mil/scra/#/single-record';
  let browser;
  let networkLogger;
  try {
    console.log('Initializing browser...');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR);
    }
    
    // Set up browser launch options with enhanced settings
    const launchOptions = { 
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--allow-insecure-localhost'
      ],
      firefoxUserPrefs: {
        'network.http.sendRefererHeader': 0,
        'browser.cache.disk.enable': false,
        'browser.cache.memory.enable': false,
        'browser.cache.offline.enable': false,
        'network.http.use-cache': false,
        'network.dns.disablePrefetch': true,
        'network.prefetch-next': false,
        'security.tls.enable_0rtt_data': false,
        'security.cert_pinning.enforcement_level': 0,
        'security.ssl.require_safe_negotiation': false,
        'security.ssl.enable_ocsp_stapling': false
      }
    };
    
    console.log('About to launch browser with options:', JSON.stringify(launchOptions, null, 2));
    browser = await firefox.launch(launchOptions).catch(e => {
      console.error('Browser launch failed:', e);
      throw e;
    });
    
    console.log('Browser launched successfully. Creating browser context...');
    
    // Use common user agents that are less likely to be blocked
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15'
    ];
    
    // Select a random user agent
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    console.log(`Using user agent: ${userAgent}`);
    
    const context = await browser.newContext({ 
      viewport: { width: 1920, height: 1080 },
      userAgent,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
      }
    }).catch(e => {
      console.error('Context creation failed:', e);
      throw e;
    });
    
    console.log('Browser context created. Creating new page...');
    const page = await context.newPage().catch(e => {
      console.error('Page creation failed:', e);
      throw e;
    });
    
    // Set up network logger
    networkLogger = setupNetworkLogging(page, runFolder);
    
    console.log('Page created successfully.');
    
    // Use retry logic for navigating to the page with increased timeout and better error handling
    await retry(
      async () => {
        console.log('Attempting to navigate to SCRA page...');
        
        // First try a simpler page to warm up the browser connection
        console.log('First navigating to Google as a warm-up...');
        await page.goto('https://www.google.com', { 
          timeout: 30000,
          waitUntil: 'domcontentloaded'
        }).catch(e => {
          console.log('Warm-up navigation failed, but continuing...', e.message);
        });
        
        // Take screenshot of Google for debugging
        await page.screenshot({ path: path.join(runFolder, 'screenshot_at_google.png') });
        console.log('Captured screenshot at Google page');
        
        // Now try to load the actual SCRA page with longer timeout
        console.log(`Now attempting to navigate to SCRA URL: ${SCRA_URL}`);
        
        try {
          // Clear cookies and cache before attempting SCRA site
          await context.clearCookies();
          
          // Try accessing the SCRA site with extended timeout
          await page.goto(SCRA_URL, { 
            waitUntil: 'domcontentloaded', 
            timeout: 90000 // 90 second timeout for government site
          });
          
          // Verify we reached the correct page by checking content
          const pageTitle = await page.title();
          const pageContent = await page.content();
          
          console.log(`Page title after navigation: ${pageTitle}`);
          
          // Check if we're on the right page or were redirected
          if (pageContent.includes('Access Denied') || pageContent.includes('Forbidden')) {
            await page.screenshot({ path: path.join(runFolder, 'screenshot_access_denied.png') });
            throw new Error('Access to SCRA site appears to be denied or blocked');
          }
          
          if (!pageContent.includes('SCRA') && !pageContent.includes('Single Record Request')) {
            await page.screenshot({ path: path.join(runFolder, 'screenshot_wrong_page.png') });
            throw new Error('Navigation succeeded but page content does not appear to be SCRA site');
          }
          
          console.log('Successfully navigated to SCRA Single Record Request page');
        } catch (navigationError) {
          console.error('Detailed navigation error:', navigationError);
          
          // Take screenshot after failed navigation attempt
          await page.screenshot({ path: path.join(runFolder, 'screenshot_navigation_error.png') });
          console.log('Captured screenshot after navigation error');
          
          // Log network summary
          if (networkLogger) {
            networkLogger.logNetworkSummary();
          }
          
          // Re-throw with more context to trigger retry
          throw new Error(`Navigation failed: ${navigationError.message}`);
        }
      }, 
      3, // max retries 
      10000, // initial delay (10s)
      60000 // max delay (60s)
    );
    
    // Take screenshot after successful navigation
    await page.screenshot({ path: path.join(runFolder, 'screenshot_after_nav.png') });
    console.log('Screenshot taken after navigation.');

    // Handle Privacy Act confirmation modal if present
    const privacyAcceptBtn = await page.$('button[title="I Accept"]');
    if (privacyAcceptBtn) {
      console.log('Privacy confirmation modal detected. Clicking Accept...');
      await privacyAcceptBtn.click();
      // Optionally wait for modal to disappear
      await page.waitForTimeout(500); // Small delay to allow modal to close
    } else {
      console.log('No privacy confirmation modal detected.');
    }

    // Check for login form
    if (await page.$('input#username')) {
      console.log('Login form detected, logging in...');
      try {
        await page.fill('input#username', scraUsername);
        await page.fill('input#password', scraPassword);
        
        console.log('Submitting login credentials...');
        await Promise.all([
          page.click("button[type='submit']"),
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 })
        ]);
        console.log('Logged in successfully');
      } catch (loginError) {
        console.error('Error during login:', loginError.message);
        await page.screenshot({ path: path.join(runFolder, 'screenshot_login_error.png') });
        throw new Error(`Login failed: ${loginError.message}`);
      }
    } else {
      console.log('No login form detected, continuing...');
    }

    // Give the page a moment to stabilize after login
    await page.waitForTimeout(2000);

    // Fill out the form fields
    try {
      // Clean SSN to ensure only digits are submitted
      const cleanedSsn = ssn.replace(/\D/g, '');
      console.log('Filling out SSN...');
      await page.fill('#ssnInput', cleanedSsn);
      await page.fill('#ssnConfirmationInput', cleanedSsn);
      console.log('Filling out Last Name...');
      await page.fill('#lastNameInput', lastName);
      console.log('Filling out First Name...');
      await page.fill('#firstNameInput', firstName);
      if (dob) {
        console.log('Filling out Date of Birth...');
        await page.fill('#mat-input-2', dob); // Format: MM/DD/YYYY
      }
    } catch (formError) {
      console.error('Error filling form:', formError.message);
      await page.screenshot({ path: path.join(runFolder, 'screenshot_form_error.png') });
      throw new Error(`Form filling failed: ${formError.message}`);
    }

    // Accept terms
    console.log('Waiting for I Accept checkbox to be attached...');
    const checkboxSelector = 'input[name="termsAgree"]';
    const labelSelector = 'label[for="mat-mdc-checkbox-7-input"]';
    let checkboxFound = false;
    
    try {
      // Wait longer for the checkbox to appear
      await page.waitForSelector(checkboxSelector, { state: 'attached', timeout: 20000 });
      await page.screenshot({ path: path.join(runFolder, 'screenshot_before_checkbox.png') });
      console.log('Screenshot taken before attempting to check I Accept checkbox.');
      
      try {
        await page.check(checkboxSelector);
        checkboxFound = true;
        console.log('Checked the checkbox using input[name="termsAgree"]');
      } catch (e) {
        console.log('Primary check failed, trying to click the label as fallback...', e.message);
        try {
          await page.click(labelSelector);
          checkboxFound = true;
          console.log('Checked the checkbox by clicking the label.');
        } catch (e2) {
          console.log('Fallback label click also failed.', e2.message);
          
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
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const pdfPath = path.join(runFolder, `scra-result.pdf`);
        
        try {
          // Use a longer timeout for the download
          const [ download ] = await Promise.all([
            page.waitForEvent('download', { timeout: 45000 }),
            page.click('button[name="SubmitButton"]'),
          ]);
          
          console.log('Download started, waiting for completion...');
          await download.saveAs(pdfPath);
          console.log(`PDF downloaded and saved to: ${pdfPath}`);

          // Parse the PDF to determine proofOfMilitaryServiceFound
          const fileData = fs.readFileSync(pdfPath);
          const pdfData = await pdfParse(fileData);
          const pdfText = pdfData.text;
          
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
          throw new Error(`Form submission failed: ${downloadError.message}`);
        }
      } else {
        throw new Error('I Accept checkbox not found or not interactable after multiple attempts.');
      }
    } catch (checkboxError) {
      console.error('Error with checkbox handling:', checkboxError.message);
      await page.screenshot({ path: path.join(runFolder, 'screenshot_checkbox_error.png') });
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