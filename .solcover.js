// solidity-coverage configuration
// Mocks are adversarial/test-only helpers and are excluded from the coverage
// denominator; all production contracts under contracts/core and contracts/tokens
// are measured.
module.exports = {
  skipFiles: ["mocks/"],
  istanbulReporter: ["text", "html", "json", "lcov"],
};
