const express = require('express');
const { runScraAutomation } = require('./scraAutomation');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080; // Match the actual port being used

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Endpoint to serve screenshots
app.get('/screenshots/:filename', (req, res) => {
  const filename = req.params.filename;
  // Only allow PNG files for security
  if (!filename.match(/^[a-zA-Z0-9_-]+\.png$/)) {
    return res.status(400).send('Invalid filename');
  }

  const filePath = path.join(process.cwd(), filename);
  
  // Check if file exists
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Screenshot not found');
  }
});

// Endpoint to list available screenshots
app.get('/screenshots', (req, res) => {
  try {
    const files = fs.readdirSync(process.cwd())
      .filter(file => file.startsWith('screenshot_') && file.endsWith('.png'));
    
    const screenshotUrls = files.map(file => {
      return {
        name: file,
        url: `${req.protocol}://${req.get('host')}/screenshots/${file}`,
        timestamp: fs.statSync(path.join(process.cwd(), file)).mtime
      };
    });
    
    res.json(screenshotUrls);
  } catch (error) {
    console.error('Error listing screenshots:', error);
    res.status(500).send('Error listing screenshots');
  }
});

// POST endpoint to receive SCRA requests from Salesforce
app.post('/scra-request', async (req, res) => {
  try {
    console.log('Received SCRA request');
    console.log('Raw request body:', JSON.stringify(req.body));
    
    // Extract fields with consideration for both camelCase and Salesforce naming conventions
    const {
      ssn,
      dob, // optional
      lastName,
      firstName,
      scraUsername,
      scraPassword,
      matterId,
      callbackUrl,
      Callback_URL__c, // Salesforce custom field format
      Server_URL__c // Salesforce server URL format
    } = req.body;

    // Determine the correct callback URL (try different possible formats)
    const effectiveCallbackUrl = callbackUrl || Callback_URL__c || req.body['Callback_URL__c'] || null;

    // Log the request (with sensitive data masked)
    console.log('Request data:', {
      ssn: ssn ? `***-**-${ssn.replace(/\D/g, '').slice(-4)}` : 'NONE',
      dob: dob || 'NONE',
      lastName,
      firstName,
      matterId,
      hasCallbackUrl: !!effectiveCallbackUrl,
      callbackUrl: effectiveCallbackUrl ? `${effectiveCallbackUrl.substring(0, 15)}...` : 'undefined',
      hasServerUrl: !!(Server_URL__c || req.body['Server_URL__c']),
      originalKeys: Object.keys(req.body)
    });

    // Send immediate response to prevent timeout
    res.status(202).json({ message: 'Request received and automation started' });

    // Then run the automation asynchronously
    runScraAutomation({
      ssn,
      dob,
      lastName,
      firstName,
      scraUsername,
      scraPassword,
      matterId,
      endpointUrl: effectiveCallbackUrl
    }).catch(err => {
      console.error('Error in automation process (caught in index.js):', err.message);
    });
  } catch (error) {
    console.error('Error handling request:', error);
    // If we haven't sent a response yet, send an error
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Handle graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    console.log(`Received ${signal}, gracefully shutting down...`);
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    
    // Force exit after 5 seconds if closing takes too long
    setTimeout(() => {
      console.log('Forcing shutdown after timeout');
      process.exit(1);
    }, 5000);
  });
}); 