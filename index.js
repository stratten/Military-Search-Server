const express = require('express');
const { runScraAutomation } = require('./scraAutomation');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// POST endpoint to receive SCRA requests from Salesforce
app.post('/scra-request', async (req, res) => {
  const {
    ssn,
    dob, // optional
    lastName,
    firstName,
    scraUsername,
    scraPassword,
    matterId,
    callbackUrl // Adding callback URL from Salesforce
  } = req.body;

  console.log('Received request with data:', {
    ssn: '***-**-' + (ssn ? ssn.slice(-4) : 'NONE'),
    dob: dob || 'NONE',
    lastName,
    firstName,
    matterId,
    callbackUrl
  });

  // Call the automation function and wait for it to complete
  await runScraAutomation({
    ssn,
    dob,
    lastName,
    firstName,
    scraUsername,
    scraPassword,
    matterId,
    endpointUrl: callbackUrl // Pass callback URL as endpointUrl
  });

  // Respond with a simple acknowledgment
  res.status(200).json({ message: 'Request received and automation started' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 