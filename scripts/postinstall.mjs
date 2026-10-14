#!/usr/bin/env node

/**
 * Post-install onboarding banner for @dimassetoid/strata-mcp
 * Displays clean next steps to guide users to initialize their project.
 */
function printBanner() {
  // Avoid printing in CI or silent install modes if unwanted
  if (process.env.CI || process.env.npm_config_loglevel === 'silent') {
    return;
  }

  const cyan = '\x1b[36m';
  const bold = '\x1b[1m';
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  console.log(`
${cyan}┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│   ${bold}✨ Strata MCP installed successfully!${reset}${cyan}                                │
│                                                                        │
│   ${bold}Next Steps:${reset}${cyan}                                                          │
│   ${dim}1. Navigate to your frontend project:${reset}${cyan}                                │
│      ${green}$ cd /path/to/your/project${reset}${cyan}                                        │
│                                                                        │
│   ${dim}2. Initialize local Strata index & agent harness config:${reset}${cyan}             │
│      ${yellow}$ strata init${reset}${cyan}                                                     │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘${reset}
`);
}

try {
  printBanner();
} catch {
  // Never fail installation due to a banner error
}
