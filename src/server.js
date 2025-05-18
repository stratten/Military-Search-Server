const express = require('express');
const { runScraAutomation } = require('./scraAutomation');
const path = require('path');
const fs = require('fs');

// Log Playwright version at runtime
try {
  console.log('Playwright version at runtime:', require('playwright/package.json').version);
} catch (e) {
  console.log('Could not determine Playwright version at runtime:', e.message);
}

const app = express();
const PORT = process.env.PORT || 8080; // Match the actual port being used

// Root directory is one level up from the src folder
const ROOT_DIR = path.join(__dirname, '..');
const OUTPUTS_DIR = path.join(ROOT_DIR, 'outputs');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

// Ensure outputs directory exists
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR);
}

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR);
}

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Endpoint to serve screenshots from run folders
app.get('/screenshots/:runFolder/:filename', (req, res) => {
  const { runFolder, filename } = req.params;
  
  // Only allow PNG files for security
  if (!filename.match(/^[a-zA-Z0-9_-]+\.png$/)) {
    return res.status(400).send('Invalid filename');
  }

  // Only allow valid run folder names for security
  if (!runFolder.match(/^run-[0-9T\-:\.]+$/)) {
    return res.status(400).send('Invalid run folder');
  }

  const filePath = path.join(OUTPUTS_DIR, runFolder, filename);
  
  // Check if file exists
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Screenshot not found');
  }
});

// Endpoint to serve the latest screenshot by type
app.get('/screenshots/latest/:type', (req, res) => {
  const { type } = req.params;
  
  // Validate screenshot type
  if (!type.match(/^screenshot_[a-zA-Z0-9_-]+\.png$/)) {
    return res.status(400).send('Invalid screenshot type');
  }
  
  try {
    // Get all run folders, sorted by date (newest first)
    const runFolders = fs.readdirSync(OUTPUTS_DIR)
      .filter(folder => folder.startsWith('run-'))
      .sort()
      .reverse();
    
    // Look for the requested screenshot type in each folder
    for (const folder of runFolders) {
      const filePath = path.join(OUTPUTS_DIR, folder, type);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }
    
    res.status(404).send('No matching screenshot found');
  } catch (error) {
    console.error('Error finding latest screenshot:', error);
    res.status(500).send('Error finding latest screenshot');
  }
});

// Endpoint to list available run folders and their screenshots
app.get('/screenshots', (req, res) => {
  try {
    // Check if outputs directory exists
    if (!fs.existsSync(OUTPUTS_DIR)) {
      return res.json({ runs: [] });
    }
    
    // Get all run folders
    const runFolders = fs.readdirSync(OUTPUTS_DIR)
      .filter(folder => folder.startsWith('run-'))
      .sort()
      .reverse();
    
    const runs = runFolders.map(folder => {
      const runPath = path.join(OUTPUTS_DIR, folder);
      
      // Get all PNG files in this run folder
      const screenshots = fs.readdirSync(runPath)
        .filter(file => file.endsWith('.png'))
        .map(file => {
          return {
            name: file,
            url: `${req.protocol}://${req.get('host')}/screenshots/${folder}/${file}`,
            timestamp: fs.statSync(path.join(runPath, file)).mtime
          };
        });
      
      // Check if there's a result file
      let result = null;
      const resultPath = path.join(runPath, 'result.json');
      if (fs.existsSync(resultPath)) {
        try {
          result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        } catch (e) {
          console.error('Error parsing result file:', e);
        }
      }
      
      return {
        name: folder,
        timestamp: folder.replace('run-', ''),
        screenshots,
        result,
        pdfUrl: fs.existsSync(path.join(runPath, 'scra-result.pdf')) ? 
          `${req.protocol}://${req.get('host')}/pdfs/${folder}/scra-result.pdf` : null
      };
    });
    
    res.json({ runs });
  } catch (error) {
    console.error('Error listing screenshots:', error);
    res.status(500).send('Error listing screenshots');
  }
});

// Endpoint to serve PDF files from run folders
app.get('/pdfs/:runFolder/:filename', (req, res) => {
  const { runFolder, filename } = req.params;
  
  // Only allow PDF files for security
  if (!filename.match(/^[a-zA-Z0-9_-]+\.pdf$/)) {
    return res.status(400).send('Invalid filename');
  }

  // Only allow valid run folder names for security
  if (!runFolder.match(/^run-[0-9T\-:\.]+$/)) {
    return res.status(400).send('Invalid run folder');
  }

  const filePath = path.join(OUTPUTS_DIR, runFolder, filename);
  
  // Check if file exists
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('PDF not found');
  }
});

// Endpoint to view error logs with pagination
app.get('/error-logs', (req, res) => {
  try {
    const errorLogPath = path.join(LOGS_DIR, 'error_log.json');
    
    // Check if error log exists
    if (!fs.existsSync(errorLogPath)) {
      return res.json({ errors: [] });
    }
    
    // Read error log
    const errorLogContent = fs.readFileSync(errorLogPath, 'utf8');
    let errorLog = [];
    
    try {
      errorLog = JSON.parse(errorLogContent);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse error log file' });
    }
    
    // Handle pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    // Sort errors by timestamp, newest first
    errorLog.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    const paginatedErrors = errorLog.slice(startIndex, endIndex);
    
    const response = {
      errors: paginatedErrors,
      pagination: {
        total: errorLog.length,
        page,
        limit,
        pages: Math.ceil(errorLog.length / limit)
      }
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error retrieving error logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to view network logs for a specific run
app.get('/network-logs/:runFolder', (req, res) => {
  try {
    const { runFolder } = req.params;
    
    // Validate run folder format
    if (!runFolder.match(/^run-[0-9T\-:\.]+$/)) {
      return res.status(400).send('Invalid run folder');
    }
    
    const networkLogPath = path.join(OUTPUTS_DIR, runFolder, 'network_log.json');
    
    // Check if network log exists
    if (!fs.existsSync(networkLogPath)) {
      return res.status(404).json({ error: 'Network log not found for this run' });
    }
    
    // Read network log
    const networkLogContent = fs.readFileSync(networkLogPath, 'utf8');
    let networkLog = [];
    
    try {
      networkLog = JSON.parse(networkLogContent);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse network log file' });
    }
    
    // Basic filtering by request type if query param is provided
    if (req.query.type) {
      networkLog = networkLog.filter(entry => entry.type === req.query.type);
    }
    
    // Handle pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    const paginatedLog = networkLog.slice(startIndex, endIndex);
    
    const response = {
      networkEvents: paginatedLog,
      summary: {
        totalRequests: networkLog.filter(e => e.type === 'request_sent').length,
        failedRequests: networkLog.filter(e => e.type === 'request_failed').length,
        errorResponses: networkLog.filter(e => e.type === 'response_error').length,
        successfulResponses: networkLog.filter(e => 
          e.type === 'response_received' && e.status < 400).length
      },
      pagination: {
        total: networkLog.length,
        page,
        limit,
        pages: Math.ceil(networkLog.length / limit)
      }
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error retrieving network logs:', error);
    res.status(500).json({ error: 'Internal server error' });
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
      Server_URL__c, // Salesforce server URL format
      endpointUrl // Direct endpoint URL
    } = req.body;

    // Clean and normalize the callback URL
    let effectiveCallbackUrl = callbackUrl || Callback_URL__c || req.body['Callback_URL__c'] || endpointUrl || null;
    
    // Process and fix the URL if it exists
    if (effectiveCallbackUrl) {
      // Clean tab characters and whitespace
      effectiveCallbackUrl = effectiveCallbackUrl.replace(/[\t\s]+/g, '');
      
      // Add protocol if missing
      if (!effectiveCallbackUrl.startsWith('http')) {
        effectiveCallbackUrl = 'https://' + effectiveCallbackUrl;
      }
      
      console.log(`Normalized callback URL: ${effectiveCallbackUrl}`);
    }

    // Log the request (with sensitive data masked)
    console.log('Request data:', {
      ssn: ssn ? `***-**-${ssn.replace(/\D/g, '').slice(-4)}` : 'NONE',
      dob: dob || 'NONE',
      lastName,
      firstName,
      matterId,
      hasCallbackUrl: !!effectiveCallbackUrl,
      callbackUrl: effectiveCallbackUrl ? 
        `${effectiveCallbackUrl.substring(0, 15)}...${effectiveCallbackUrl.substring(effectiveCallbackUrl.length - 10)}` : 
        'undefined',
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
      console.error('Error in automation process (caught in server.js):', err.message);
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