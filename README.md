# SCRA Proxy Server

A service that automates SCRA (Servicemembers Civil Relief Act) single record requests, interacting with the DMDC SCRA website to retrieve and process proof of military service documents.

## Project Structure

```
├── config/                      # Configuration and test files
│   ├── testConstants.js         # Test data
│   └── testScraAutomation.js    # Test script
├── src/                         # Source code
│   ├── scraAutomation.js        # SCRA automation logic
│   └── server.js                # Express server
├── outputs/                     # Each run's outputs (screenshots, PDFs, results)
│   └── run-[timestamp]/         # Individual run folder with all outputs
│       ├── network_log.json     # Detailed network request/response log
│       ├── screenshots/*.png    # Screenshots at various stages
│       ├── scra-result.pdf      # Downloaded PDF result
│       ├── result.json          # Parsed results
│       └── error_report.json    # Error details (if occurred)
├── logs/                        # Log files
│   └── error_log.json           # Centralized error tracking
├── Dockerfile                   # Container configuration
├── index.js                     # Main entry point
├── package.json                 # Project dependencies
└── README.md                    # This file
```

## Features

- **Automated SCRA Verification**: Submits requests to the DMDC SCRA website
- **Salesforce Integration**: Receives requests from Salesforce and returns results
- **Enhanced Error Handling**: Comprehensive retry logic with exponential backoff
- **Detailed Network Monitoring**: Logs all network traffic for debugging
- **Robust Browser Configuration**: Optimized for government website compatibility
- **Centralized Error Tracking**: Consolidated error log for easier troubleshooting
- **Organized Output Structure**: Each run creates a separate folder with all outputs

## Usage

### Installation

```bash
npm install
```

### Running the Server

```bash
npm start
```

### Testing

```bash
npm test
```

### API Endpoints

- `GET /health` - Health check endpoint
- `GET /screenshots` - Lists all run folders with their screenshots, PDFs, and results
- `GET /screenshots/:runFolder/:filename` - Gets a specific screenshot
- `GET /screenshots/latest/:type` - Gets the latest version of a specific screenshot type
- `GET /pdfs/:runFolder/:filename` - Gets a PDF file from a run folder
- `GET /error-logs` - Retrieves error logs with pagination (supports ?page=1&limit=10)
- `GET /network-logs/:runFolder` - Gets network logs for a specific run (supports ?type=request_failed&page=1&limit=50)
- `POST /scra-request` - Initiates an SCRA request

### POST /scra-request Body Parameters

```json
{
  "ssn": "000-00-0000",
  "dob": "01/01/1990", // Optional
  "lastName": "Last",
  "firstName": "First",
  "scraUsername": "USERNAME",
  "scraPassword": "PASSWORD",
  "matterId": "MATTER_ID",
  "callbackUrl": "https://callback-url.example.com"
}
```

## Deployment

The project is configured to deploy on Railway, with the Dockerfile handling all dependencies and setup. The application requires sufficient resources for browser automation:

- Memory: 32GB recommended
- CPU: 32vCPU recommended
- These requirements match successful implementations of similar automation projects

## Troubleshooting

### Common Issues

1. **Connection Errors**: Government websites often restrict access from cloud hosting providers. The application includes:
   - Sophisticated retry logic with exponential backoff
   - Detailed network request logging
   - Browser configuration optimizations 
   - User-agent rotation
   - Access detection and reporting

2. **PDF Download Failures**: Extended timeouts and enhanced error reporting help diagnose download issues.

### Debugging Tools

- Each automation run creates comprehensive logs and screenshots
- Network activity is tracked in detail to identify blocking or failures
- Error reports consolidate all relevant information for rapid diagnosis
- Use the `/error-logs` and `/network-logs/:runFolder` endpoints to investigate issues

## Output Organization

Each run creates a timestamped folder in `outputs/` containing:
- Screenshots at various stages of the process
- Detailed network request/response logs
- PDF result from SCRA
- JSON files with results, error reports, and callback status 