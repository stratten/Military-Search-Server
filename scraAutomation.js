const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const axios = require('axios');

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
        '--disable-gpu'
      ]
    });
    const context = await browser.newContext({ viewport: { width: 1200, height: 1600 } });
    const page = await context.newPage();
    await page.goto(SCRA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Navigated to SCRA Single Record Request page');

    // Screenshot after navigation
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
      await page.fill('input#username', scraUsername);
      await page.fill('input#password', scraPassword);
      await Promise.all([
        page.click("button[type='submit']"),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
      ]);
      console.log('Logged in successfully');
    } else {
      console.log('No login form detected, continuing...');
    }

    // Fill out the form fields
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
    // Accept terms
    console.log('Waiting for I Accept checkbox to be attached...');
    const checkboxSelector = 'input[name="termsAgree"]';
    const labelSelector = 'label[for="mat-mdc-checkbox-7-input"]';
    let checkboxFound = false;
    await page.waitForSelector(checkboxSelector, { state: 'attached', timeout: 10000 });
    await page.screenshot({ path: path.join(process.cwd(), 'screenshot_before_checkbox.png') });
    console.log('Screenshot taken before attempting to check I Accept checkbox.');
    try {
      await page.check(checkboxSelector);
      checkboxFound = true;
      console.log('Checked the checkbox using input[name="termsAgree"]');
    } catch (e) {
      console.log('Primary check failed, trying to click the label as fallback...');
      try {
        await page.click(labelSelector);
        checkboxFound = true;
        console.log('Checked the checkbox by clicking the label.');
      } catch (e2) {
        console.log('Fallback label click also failed.');
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
      const [ download ] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        page.click('button[name="SubmitButton"]'),
      ]);
      await download.saveAs(pdfPath);
      console.log(`PDF downloaded and saved to: ${pdfPath}`);

      // Parse the PDF to determine proofOfMilitaryServiceFound
      const fileData = fs.readFileSync(pdfPath);
      const pdfData = await pdfParse(fileData);
      const pdfText = pdfData.text;
      // Simple heuristic: look for any value in the relevant sections that is not 'NA' or 'No'
      // (You may want to refine this based on actual PDF structure)
      let proofOfMilitaryServiceFound = 'No';
      const regex = /Start Date[\s\S]*?Service Component[\s\S]*?(\w+)/i;
      // Look for lines after the relevant headers
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
          const postPayload = {
            matterId,
            proofOfMilitaryServiceFound,
            pdf: fileData.toString('base64')
          };
          const postResp = await axios.post(endpointUrl, postPayload, {
            headers: { 'Content-Type': 'application/json' }
          });
          console.log(`POST to SF endpoint succeeded: ${postResp.status} ${postResp.statusText}`);
        } catch (err) {
          console.error('POST to SF endpoint failed:', err.response ? err.response.data : err.message);
        }
      }
    } else {
      throw new Error('I Accept checkbox not found or not interactable.');
    }

    // Do not handle PDF download yet
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