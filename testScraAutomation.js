const { runScraAutomation } = require('./scraAutomation');
const testConstants = require('./testConstants');

(async () => {
  console.log('Starting SCRA automation test...');
  await runScraAutomation(testConstants);
  console.log('SCRA automation test complete.');
})(); 