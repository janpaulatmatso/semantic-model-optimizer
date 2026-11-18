#!/usr/bin/env node
/* Builds the MSIX package for the Microsoft Store: dist/SemanticModelOptimizer.msix
 *   node build-exe.js && node build-installer.js && node build-msix.js
 * It packs dist/app/SemanticModelOptimizer.exe (the program) and dist/SemanticModelOptimizer-cli.exe (the command line)
 * with a manifest and logos. The Store signs the package itself, so this one is not signed.
 *
 * The identity comes from Partner Center (Product identity), in these environment variables:
 *   SMO_MSIX_NAME            Package/Identity/Name, for example 12345Matso.SemanticModelOptimizer
 *   SMO_MSIX_PUBLISHER       Package/Identity/Publisher, for example CN=AB12CD34-...
 *   SMO_MSIX_PUBLISHER_NAME  Package/Properties/PublisherDisplayName, for example Matso
 * Without them it builds a test package (for the install check in the release workflow), not one for the Store.
 * Needs makeappx.exe and makepri.exe from the Windows SDK; set WINDOWS_SDK_BIN to their folder if they are not found. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const icon = require('./icon.js');

const root = __dirname, dist = path.join(root, 'dist');
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Store versions have four parts, the last one 0. */
function msixVersion(v) {
  const p = String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  while (p.length < 3) p.push(0);
  return p.slice(0, 3).join('.') + '.0';
}

function identity() {
  const name = process.env.SMO_MSIX_NAME, publisher = process.env.SMO_MSIX_PUBLISHER;
  if (name && publisher) return { name, publisher, publisherName: process.env.SMO_MSIX_PUBLISHER_NAME || 'Matso', store: true };
  return { name: 'SemanticModelOptimizer.Test', publisher: 'CN=SemanticModelOptimizerTest', publisherName: 'Semantic Model Optimizer (test)', store: false };
}

const DESCRIPTION = 'Which measures and columns of a Power BI model are used in reports, their lineage, checks and a model diagram.';

function manifest(id, version) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap3 desktop desktop6 rescap">
  <Identity Name="${xml(id.name)}" Publisher="${xml(id.publisher)}" Version="${version}" ProcessorArchitecture="x64"/>
  <Properties>
    <DisplayName>Semantic Model Optimizer</DisplayName>
    <PublisherDisplayName>${xml(id.publisherName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <Description>${xml(DESCRIPTION)}</Description>
    <!-- the program opens your own browser in app mode: that browser must use its real profile, not a copy inside the package -->
    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
    <desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0"/>
  </Dependencies>
  <Resources>
    <Resource Language="en-us"/>
  </Resources>
  <Applications>
    <Application Id="App" Executable="app\\SemanticModelOptimizer.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Semantic Model Optimizer" Description="${xml(DESCRIPTION)}" BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png"/>
      <Extensions>
        <uap3:Extension Category="windows.appExecutionAlias" Executable="app\\SemanticModelOptimizer.exe" EntryPoint="Windows.FullTrustApplication">
          <uap3:AppExecutionAlias><desktop:ExecutionAlias Alias="SemanticModelOptimizer.exe"/></uap3:AppExecutionAlias>
        </uap3:Extension>
      </Extensions>
    </Application>
    <Application Id="Cli" Executable="SemanticModelOptimizer-cli.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Semantic Model Optimizer (command line)" Description="${xml(DESCRIPTION)}" BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" AppListEntry="none"/>
      <Extensions>
        <uap3:Extension Category="windows.appExecutionAlias" Executable="SemanticModelOptimizer-cli.exe" EntryPoint="Windows.FullTrustApplication">
          <uap3:AppExecutionAlias><desktop:ExecutionAlias Alias="SemanticModelOptimizer-cli.exe"/></uap3:AppExecutionAlias>
        </uap3:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust"/>
    <rescap:Capability Name="unvirtualizedResources"/>
  </Capabilities>
</Package>
`;
}

/** The logos the manifest names, plus icon sizes for the taskbar and Start without a coloured plate (via resources.pri). */
function logos(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, size) => fs.writeFileSync(path.join(dir, name), icon.png(size));
  put('StoreLogo.png', 50);
  put('Square150x150Logo.png', 150);
  put('Square44x44Logo.png', 44);
  for (const s of [16, 24, 32, 48, 256]) {
    put(`Square44x44Logo.targetsize-${s}.png`, s);
    put(`Square44x44Logo.targetsize-${s}_altform-unplated.png`, s);
  }
}

function sdkTool(name) {
  const dirs = [];
  if (process.env.WINDOWS_SDK_BIN) dirs.push(process.env.WINDOWS_SDK_BIN);
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (fs.existsSync(kits)) {
    for (const v of fs.readdirSync(kits).filter(d => /^10\./.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) dirs.push(path.join(kits, v, 'x64'));
  }
  return dirs.map(d => path.join(d, name)).find(p => fs.existsSync(p)) || null;
}

function build() {
  const app = path.join(dist, 'app', 'SemanticModelOptimizer.exe'), cli = path.join(dist, 'SemanticModelOptimizer-cli.exe');
  for (const f of [app, cli]) if (!fs.existsSync(f)) { console.error('Missing ' + f + ': run node build-exe.js and node build-installer.js first.'); process.exit(2); }
  const version = msixVersion(process.env.SMO_VERSION || require('./package.json').version);
  const id = identity();
  const stage = path.join(dist, 'msix');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'app'), { recursive: true });
  fs.copyFileSync(app, path.join(stage, 'app', 'SemanticModelOptimizer.exe'));
  fs.copyFileSync(cli, path.join(stage, 'SemanticModelOptimizer-cli.exe'));
  logos(path.join(stage, 'Assets'));
  fs.writeFileSync(path.join(stage, 'AppxManifest.xml'), manifest(id, version));

  const makepri = sdkTool('makepri.exe'), makeappx = sdkTool('makeappx.exe');
  if (!makeappx || !makepri) { console.error('makeappx.exe or makepri.exe not found (Windows SDK). The package contents are in ' + stage + '.'); process.exit(2); }
  const cfg = path.join(dist, 'priconfig.xml');
  execFileSync(makepri, ['createconfig', '/cf', cfg, '/dq', 'en-US', '/o'], { stdio: 'inherit' });
  execFileSync(makepri, ['new', '/pr', stage, '/cf', cfg, '/of', path.join(stage, 'resources.pri'), '/o'], { stdio: 'inherit' });
  const out = path.join(dist, 'SemanticModelOptimizer.msix');
  execFileSync(makeappx, ['pack', '/d', stage, '/p', out, '/o'], { stdio: 'inherit' });
  console.log('Built ' + out + ' version ' + version + (id.store ? ' for the Store (' + id.name + ')' : ' as a test package (no Store identity set)') +
    ', ' + Math.round(fs.statSync(out).size / 1048576) + ' MB.');
  return { out, version, id };
}

if (require.main === module) build();
module.exports = { manifest, msixVersion, identity, logos };
