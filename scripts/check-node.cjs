// Runs before install, dev, build and test on whatever Node is installed, so it must stay plain CommonJS.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    [
      '',
      `Cairn needs Node 22.12 or newer, but this machine has Node ${process.versions.node}.`,
      'Electron 44 and the build tools will not run on older versions.',
      '',
      'Fix: install the current LTS from https://nodejs.org (or run: winget install OpenJS.NodeJS.LTS),',
      'open a NEW terminal, confirm with "node -v", then run "npm install" again.',
      ''
    ].join('\n')
  )
  process.exit(1)
}
