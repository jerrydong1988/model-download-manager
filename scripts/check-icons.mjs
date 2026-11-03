import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = path => readFileSync(resolve(root, path))
const catalog = JSON.parse(read('src/components/icons/catalog.json'))
const manifest = JSON.parse(read('assets/icons/manifest.json'))
const exports = read('src/components/icons/index.ts').toString()
const names = Object.keys(catalog)
assert.equal(names.length, manifest.icons.length, 'Catalog and export manifest differ')
assert.equal(new Set(manifest.icons.map(icon => icon.file)).size, names.length, 'Duplicate SVG filenames')
for (const item of manifest.icons) {
  assert.ok(catalog[item.name]?.nodes.length, `Missing geometry: ${item.name}`)
  assert.ok(exports.includes(`export const ${item.name} = createIcon('${item.name}')`), `Missing React export: ${item.name}`)
  const svg = read(`assets/icons/${item.file}`).toString()
  assert.ok(svg.includes('viewBox="0 0 24 24"') && svg.includes('stroke-width="1.75"'), `Wrong icon grid/stroke: ${item.name}`)
  assert.ok(svg.includes('currentColor') && svg.includes('<title>'), `Missing theme/a11y metadata: ${item.name}`)
  assert.ok(!/<(?:script|image|foreignObject)\b|\bon\w+=|NaN/.test(svg), `Unexpected SVG content: ${item.name}`)
  if (item.origin.startsWith('lucide')) assert.ok(svg.includes('ISC license'), `Missing attribution: ${item.name}`)
  assert.ok(read(`assets/icons/ui-dark/${item.file.slice(3)}`).toString().includes('stroke="#f2f2f5"'),`Missing fixed dark export: ${item.name}`)
}
function pngDimensions(path, width, height = width) {
  const png = read(path)
  assert.equal(png.subarray(0,8).toString('hex'), '89504e470d0a1a0a', `Invalid PNG: ${path}`)
  assert.equal(png.readUInt32BE(16), width, `Wrong PNG width: ${path}`)
  assert.equal(png.readUInt32BE(20), height, `Wrong PNG height: ${path}`)
  assert.equal(png[25], 6, `PNG must preserve RGBA transparency: ${path}`)
}
for (const size of [16,20,24,32,48,64,128,256,512,1024]) pngDimensions(`assets/icons/png/app-${size}.png`,size)
for (const size of [16,20,24,32]) pngDimensions(`assets/icons/png/tray-${size}.png`,size)
pngDimensions('src-tauri/icons/tray-icon.png',32)
pngDimensions('public/favicon-32.png',32)
const config = JSON.parse(read('src-tauri/tauri.conf.json'))
for (const icon of config.bundle.icon) assert.ok(existsSync(resolve(root,'src-tauri',icon)), `Missing packaged icon: ${icon}`)
const ico=read('src-tauri/icons/icon.ico')
assert.equal(ico.readUInt16LE(2),1,'Invalid ICO header')
const sizes=[]
for(let index=0;index<ico.readUInt16LE(4);index++) {
  const entry=6+index*16
  const size=ico[entry]||256
  assert.equal(ico[entry+1]||256,size,'Non-square ICO frame')
  assert.ok(ico.readUInt32LE(entry+12)+ico.readUInt32LE(entry+8)<=ico.length,'Truncated ICO frame')
  sizes.push(size)
}
for (const size of [16,32,48,256]) assert.ok(sizes.includes(size),`Missing native ICO size ${size}`)
for (const file of readdirSync(resolve(root,'src'),{recursive:true}).filter(f=>/\.tsx?$/.test(f)&&!f.replaceAll('\\','/').startsWith('components/icons/'))) {
  assert.ok(!read(`src/${file}`).toString().includes("from 'lucide-react'"),`Unmigrated icon consumer: ${file}`)
}
assert.ok(read('assets/icons/LICENSE-lucide.txt').toString().includes('ISC License'))
console.log(`Icon checks passed: ${names.length} SVG/React exports, ${manifest.icons.filter(i=>i.origin==='project').length} original glyphs, 14 PNG sizes, ICO ${sizes.join('/')}, and all UI consumers.`)
