const axios = require('axios');

// Base data (modify as needed, especially endpointUrl if testing against a live callback)
const baseTestData = {
  scraUsername: 'STRATTWALDT380559',
  scraPassword: 'Adansonia2!Adansonia2!',
  firstName: 'Matthew John',
  lastName: 'Gedz',
  ssn: '322-86-7143',
  dob: null, // Or a valid date string like '01/01/1980'
  // The endpointUrl for actual callbacks should be a real, accessible URL.
  // For local testing where you just want to see the queue work, a placeholder is fine
  // but the server will try to POST to it.
  endpointUrl: 'http://localhost:9999/fake-salesforce-callback' // A dummy endpoint
};

const SERVER_URL = 'http://localhost:8080/scra-request'; // Adjust if your server runs elsewhere
const NUMBER_OF_REQUESTS = 3;

async function sendTestRequest(matterIdSuffix) {
  const testPayload = {
    ...baseTestData,
    matterId: `testMatter_${Date.now()}_${matterIdSuffix}`,
    // You could vary other fields per request if needed
    // firstName: baseTestData.firstName + matterIdSuffix 
  };

  console.log(`Sending request for Matter ID: ${testPayload.matterId}`);
  try {
    const response = await axios.post(SERVER_URL, testPayload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`Response for ${testPayload.matterId}:`);
    console.log(`  Status: ${response.status} ${response.statusText}`);
    console.log('  Data:', response.data);
    return response.data;
  } catch (error) {
    console.error(`Error sending request for ${testPayload.matterId}:`, error.response ? error.response.data : error.message);
    if (error.response) {
        console.error('  Error Status:', error.response.status);
        console.error('  Error Headers:', error.response.headers);
    }
    throw error;
  }
}

async function runMultipleRequestsTest() {
  console.log(`Starting multiple request test: ${NUMBER_OF_REQUESTS} requests to ${SERVER_URL}`);
  
  const requestPromises = [];
  for (let i = 1; i <= NUMBER_OF_REQUESTS; i++) {
    requestPromises.push(sendTestRequest(String(i)));
  }

  try {
    const results = await Promise.all(requestPromises);
    console.log('\n--- All initial responses received ---');
    results.forEach((result, index) => {
      console.log(`Result ${index + 1}:`, result);
    });
    console.log('\nTest script finished sending requests.');
    console.log('Observe server logs to see sequential processing by runScraAutomation.');
    console.log('Ensure your server is running with \'node src/server.js\' (or similar).');
    console.log('The dummy endpointUrl in this script is http://localhost:9999/fake-salesforce-callback - the server will attempt to POST results there.');
  } catch (error) {
    console.error('\n--- Test failed due to one or more requests failing ---');
    // Error details already logged by sendTestRequest
  }
}

runMultipleRequestsTest(); 