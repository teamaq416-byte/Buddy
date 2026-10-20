// Runs on the user's PC via Electron-as-Node: copies electron.exe → Buddy.exe with icon + version info.
// usage: electron.exe stamp.mjs <source.exe> <target.exe> <icon.ico> <version>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const [src, dst, icoPath, version = '2.0.0'] = process.argv.slice(2);
const ResEdit = await import(path.join(here, '..', 'node_modules', 'resedit', 'dist', 'index.js'));
const exe = ResEdit.NtExecutable.from(fs.readFileSync(src));
const res = ResEdit.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map(i => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
const [maj, min, pat] = String(version).split('.').map(n => parseInt(n, 10) || 0);
vi.setFileVersion(maj, min, pat, 0, 1033); vi.setProductVersion(maj, min, pat, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'Buddy', FileDescription: 'Buddy — local AI companion', CompanyName: 'Bolt', OriginalFilename: 'Buddy.exe', InternalName: 'Buddy', FileVersion: version, ProductVersion: version });
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(dst, Buffer.from(exe.generate()));
console.log('stamped', dst);
