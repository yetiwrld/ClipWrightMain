/**
 * electron-builder configuration for Clipwright Studio (Windows x64).
 *
 * Produces:
 *   • an NSIS installer (per-user, no admin prompt)
 *   • a single portable .exe
 *
 * ffmpeg/ffprobe and whisper.cpp binaries are shipped as *unpacked resources* so
 * the app works on a clean Windows machine with no installs, and so the binaries
 * can be executed from disk (asar cannot exec).
 */
const path = require('node:path')

const root = __dirname

module.exports = {
  appId: 'studio.clipwright.app',
  productName: 'Clipwright Studio',
  copyright: `Copyright © ${new Date().getFullYear()} Clipwright Studio`,
  // Explicit hyphenated names: electron-builder rewrites spaces in an artifact
  // name to dots, which makes "Clipwright Studio-Setup-…" turn into
  // "Clipwright.Studio-Setup-…" — awkward in links and shell commands.
  artifactName: 'Clipwright-Studio-${version}-${arch}-${os}.${ext}',

  directories: {
    output: 'release',
    buildResources: 'build'
  },

  // Only ship the compiled output and the runtime dependency `fflate` (everything
  // else is bundled into out/ by electron-vite).
  files: [
    'out/**/*',
    'package.json',
    'node_modules/fflate/**/*',
    '!**/*.map',
    '!**/node_modules/**/{test,__tests__,tests,example,examples,docs,doc}/**',
    '!**/node_modules/**/*.{md,markdown,ts,tsx,d.ts}'
  ],

  // Binaries that must be executable on disk.
  extraResources: [
    {
      from: 'resources/ffmpeg',
      to: 'ffmpeg',
      filter: ['**/*'],
      // The download script fills this folder in CI; an empty folder is harmless.
    },
    {
      from: 'resources/bin',
      to: 'bin',
      filter: ['**/*']
    },
    {
      from: 'resources/fonts',
      to: 'fonts',
      filter: ['**/*.ttf']
    },
    {
      from: 'LICENSES',
      to: 'LICENSES',
      filter: ['**/*']
    }
  ],

  asar: true,
  asarUnpack: ['**/*.node'],

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] }
    ],
    icon: path.join(root, 'build', 'icon.ico'),
    legalTrademarks: 'Clipwright Studio',
    requestedExecutionLevel: 'asInvoker',
    // Signing is configured through environment variables when available; the
    // build stays unsigned otherwise and the release notes say so explicitly.
    signAndEditExecutable: true,
    verifyUpdateCodeSignature: false
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Clipwright Studio',
    uninstallDisplayName: 'Clipwright Studio ${version}',
    deleteAppDataOnUninstall: false,
    installerIcon: path.join(root, 'build', 'icon.ico'),
    uninstallerIcon: path.join(root, 'build', 'icon.ico'),
    installerHeaderIcon: path.join(root, 'build', 'icon.ico'),
    artifactName: 'Clipwright-Studio-Setup-${version}-${arch}.${ext}',
    include: 'build/installer.nsh'
  },

  portable: {
    artifactName: 'Clipwright-Studio-Portable-${version}-${arch}.${ext}',
    unpackDirName: 'ClipwrightStudio'
  },

  // Update metadata consumed by the in-app updater (which reads GitHub Releases
  // directly, so this is documentation rather than a live feed).
  publish: [
    {
      provider: 'github',
      owner: 'yetiwrld',
      repo: 'ClipWrightMain',
      releaseType: 'release'
    }
  ],

  compression: 'maximum',
  removePackageScripts: true,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,

  fileAssociations: [
    {
      ext: 'clipwright',
      name: 'Clipwright project package',
      description: 'Clipwright Studio project package',
      icon: path.join(root, 'build', 'icon.ico'),
      role: 'Editor'
    }
  ]
}
