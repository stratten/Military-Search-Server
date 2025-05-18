const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const axios = require('axios');

// Helper function to implement retry logic
async function retry(fn, retries = 3, delay = 5000, finalError = null) {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) {
      throw finalError || error;
    }
    console.log(`Attempt failed, retrying in ${delay/1000} seconds... (${retries} retries left)`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return retry(fn, retries - 1, delay, error);
  }
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
  console.log('Running SCRA automation with:', {
    ssn,
    dob,
    lastName,
    firstName,
    scraUsername,
    scraPassword,
    matterId,
    endpointUrl
  });

  const SCRA_URL = 'https://scra.dmdc.osd.mil/scra/#/single-record';
  let browser;
  try {
    browser = await firefox.launch({ 
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
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      firefoxUserPrefs: {
        'network.http.sendRefererHeader': 0,
        'browser.cache.disk.enable': false,
        'browser.cache.memory.enable': false,
        'browser.cache.offline.enable': false,
        'network.http.use-cache': false
      }
    });
    
    // Use a common user agent for better compatibility
    const context = await browser.newContext({ 
      viewport: { width: 1200, height: 1600 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    // Use retry logic for navigating to the page with increased timeout
    await retry(async () => {
      console.log('Attempting to navigate to SCRA page...');
      
      // First try a simpler page to warm up the browser connection
      console.log('First navigating to Google as a warm-up...');
      await page.goto('https://www.google.com', { timeout: 20000 }).catch(e => {
        console.log('Warm-up navigation failed, but continuing...', e.message);
      });
      
      // Take screenshot of Google for debugging
      await page.screenshot({ path: path.join(process.cwd(), 'screenshot_at_google.png') });
      console.log('Captured screenshot at Google page');
      
      // Now try to load the actual SCRA page with longer timeout
      console.log(`Now attempting to navigate to SCRA URL: ${SCRA_URL}`);
      
      // Set up request event listeners to see if requests are being made/blocked
      page.on('request', request => {
        console.log(`Request issued to: ${request.url()}`);
      });
      
      page.on('requestfailed', request => {
        console.log(`Request failed for: ${request.url()}`);
        console.log(`Request failure reason: ${request.failure().errorText}`);
      });
      
      page.on('response', response => {
        console.log(`Response received from: ${response.url()}, status: ${response.status()}`);
      });
      
      try {
        await page.goto(SCRA_URL, { 
          waitUntil: 'domcontentloaded', 
          timeout: 60000 
        });
        console.log('Successfully navigated to SCRA Single Record Request page');
      } catch (navigationError) {
        console.error('Detailed navigation error:', navigationError);
        // Take screenshot after failed navigation attempt
        await page.screenshot({ path: path.join(process.cwd(), 'screenshot_navigation_error.png') });
        console.log('Captured screenshot after navigation error');
        // Re-throw to trigger retry
        throw navigationError;
      }
    }, 2, 10000);
    
    // Take screenshot after navigation
    await page.screenshot({ path: path.join(process.cwd(), 'screenshot_after_nav.png') });
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
        await page.screenshot({ path: path.join(process.cwd(), 'screenshot_login_error.png') });
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
      await page.screenshot({ path: path.join(process.cwd(), 'screenshot_form_error.png') });
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
      await page.screenshot({ path: path.join(process.cwd(), 'screenshot_before_checkbox.png') });
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
        // Set up download handling
        const outputDir = path.join(process.cwd(), 'outputs');
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir);
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const pdfPath = path.join(outputDir, `scra-result-${timestamp}.pdf`);
        
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

          // POST to endpoint if provided
          if (endpointUrl) {
            try {
              console.log(`Sending results to callback URL: ${endpointUrl.substring(0, 30)}...`);
              const postPayload = {
                matterId,
                proofOfMilitaryServiceFound,
                pdf: fileData.toString('base64')
              };
              
              const postResp = await axios.post(endpointUrl, postPayload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000 // 30 second timeout for the callback
              });
              
              console.log(`POST to endpoint succeeded: ${postResp.status} ${postResp.statusText}`);
            } catch (err) {
              console.error('POST to endpoint failed:', err.response ? err.response.data : err.message);
              throw new Error(`Failed to send results: ${err.message}`);
            }
          } else {
            console.log('No endpoint URL provided, skipping results submission');
          }
        } catch (downloadError) {
          console.error('Error during form submission or download:', downloadError.message);
          await page.screenshot({ path: path.join(process.cwd(), 'screenshot_download_error.png') });
          throw new Error(`Form submission failed: ${downloadError.message}`);
        }
      } else {
        throw new Error('I Accept checkbox not found or not interactable after multiple attempts.');
      }
    } catch (checkboxError) {
      console.error('Error with checkbox handling:', checkboxError.message);
      await page.screenshot({ path: path.join(process.cwd(), 'screenshot_checkbox_error.png') });
      throw checkboxError;
    }
  } catch (err) {
    console.error('Error during SCRA automation:', err);
    if (browser) {
      try {
        const page = browser.contexts()[0]?.pages()[0];
        if (page) {
          await page.screenshot({ path: path.join(process.cwd(), 'screenshot_on_error.png') });
          console.log('Screenshot taken on error.');
        }
      } catch (screenshotErr) {
        console.error('Failed to take screenshot on error:', screenshotErr);
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { runScraAutomation }; 