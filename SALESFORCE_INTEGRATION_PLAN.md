# SCRA Proxy Integration: Salesforce Context & Instructions

## Context
- A Node.js server automates SCRA (Servicemembers Civil Relief Act) single record requests.
- Salesforce (SF) initiates the process by sending a POST request to the Node.js server with the following fields:
  - `ssn` (required)
  - `dob` (optional)
  - `lastName` (required)
  - `firstName` (required)
  - `scraUsername` (required)
  - `scraPassword` (required)
  - `matterId` (required)
  - `endpointUrl` (optional, for POST-back)
- The server automates the SCRA website using Playwright, downloads the resulting PDF, parses it, and determines if military service is found.
- The server then POSTs back to Salesforce (or a test endpoint) with:
  - `matterId`
  - `proofOfMilitaryServiceFound` ("Yes" or "No")
  - The PDF as a base64-encoded string

## Instructions for Salesforce Integration

### 1. Triggering the Request
- Salesforce should send a POST request to the Node.js server's `/scra-request` endpoint with the required fields.
- Ensure all required fields are present and valid.

### 2. Receiving the Response
- The Node.js server will POST back to a specified Salesforce endpoint (provided as `endpointUrl`).
- The payload will be JSON:
  ```json
  {
    "matterId": "string",
    "proofOfMilitaryServiceFound": "Yes" | "No",
    "pdfBase64": "base64-encoded PDF string"
  }
  ```
- Salesforce should be ready to receive and process this payload, including decoding and storing the PDF as an Attachment or File.

### 3. Error Handling
- If the SCRA automation fails, the Node.js server should POST an error message to Salesforce (or log it, depending on requirements).
- Salesforce should handle and log any errors or malformed payloads.

### 4. Security
- Ensure that the endpoint receiving the POST from the Node.js server is secured (e.g., with authentication, IP whitelisting, or a secret token).
- Sensitive data (SSN, credentials) should be handled according to compliance requirements.

### 5. Testing
- Use a tool like Beeceptor or Postman to test the POST-back payload before going live.
- Confirm that Salesforce can correctly parse and store the PDF and associated fields.

---

_You can use or adapt the above as a handoff or requirements doc for the Salesforce developer/team. If you need a more technical payload schema, sample Apex code, or a checklist for the Salesforce side, let me know!_ 