const axios = require('axios');
const fs = require('fs');
const path = require('path');
const testConstants = require('./testConstants');

// Base directory for outputs
const OUTPUTS_DIR = path.join(__dirname, '..', 'outputs');
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR);
}

// Create a test folder
const timestamp = new Date().toISOString().replace(/:/g, '-');
const testFolder = path.join(OUTPUTS_DIR, `sftest-${timestamp}`);
fs.mkdirSync(testFolder);

async function testSalesforceEndpoint() {
  console.log(`Testing Salesforce endpoint: ${testConstants.endpointUrl}`);
  
  try {
    // Create a small test PDF (just a few bytes to keep the payload small)
    const testPdfPath = path.join(testFolder, 'test.pdf');
    fs.writeFileSync(testPdfPath, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>\nendobj\n3 0 obj<</Type/Page/MediaBox[0 0 595 842]/Parent 2 0 R/Resources<<>>>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF');
    
    // Read the test PDF
    const pdfData = fs.readFileSync(testPdfPath);
    
    // Create payload with field names matching the Salesforce handler
    const testPayload = {
      matterId: testConstants.matterId,
      proofOfMilitaryServiceFound: 'No',
      pdfBase64: pdfData.toString('base64')
    };
    
    // Save the request payload for debugging
    fs.writeFileSync(
      path.join(testFolder, 'request.json'),
      JSON.stringify(testPayload, null, 2)
    );
    
    console.log('Sending test request to Salesforce...');
    const response = await axios.post(testConstants.endpointUrl, testPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 60000  // Increased from 30000 to 60000 (60 seconds)
    });
    
    console.log(`Response status: ${response.status} ${response.statusText}`);
    
    // Check if response is HTML instead of JSON
    const isHtmlResponse = 
      typeof response.data === 'string' && 
      (response.data.includes('<!DOCTYPE HTML') || response.data.includes('<html'));
    
    if (isHtmlResponse) {
      console.warn('Warning: Received HTML response from Salesforce endpoint instead of JSON.');
      console.warn('This indicates that the endpoint is not correctly configured to receive API requests.');
    } else {
      console.log('Received valid response from Salesforce endpoint:', response.data);
    }
    
    // Save the response for debugging
    fs.writeFileSync(
      path.join(testFolder, 'response.json'),
      JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        data: response.data,
        isHtmlResponse
      }, null, 2)
    );
    
    console.log(`Test complete. Results saved to ${testFolder}`);
    
  } catch (error) {
    console.error('Error testing Salesforce endpoint:');
    
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error(`Status: ${error.response.status}`);
      console.error('Response data:', error.response.data);
      
      // Save error response
      fs.writeFileSync(
        path.join(testFolder, 'error.json'),
        JSON.stringify({
          status: error.response.status,
          data: error.response.data,
          message: error.message
        }, null, 2)
      );
    } else if (error.request) {
      // The request was made but no response was received
      console.error('No response received from server');
      console.error(error.request);
      
      fs.writeFileSync(
        path.join(testFolder, 'error.json'),
        JSON.stringify({
          message: 'No response received from server',
          error: error.message
        }, null, 2)
      );
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('Error setting up request:', error.message);
      
      fs.writeFileSync(
        path.join(testFolder, 'error.json'),
        JSON.stringify({
          message: error.message
        }, null, 2)
      );
    }
    
    console.log(`Test failed. Error details saved to ${testFolder}`);
  }
}

testSalesforceEndpoint();