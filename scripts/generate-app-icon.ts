import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const repoRoot = process.cwd();
const buildDir = path.join(repoRoot, "build");
const iconSvgPath = path.join(buildDir, "icon.svg");
const iconPngPath = path.join(buildDir, "icon.png");
const iconIcoPath = path.join(buildDir, "icon.ico");

const svg = String.raw`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
  <defs>
    <linearGradient id="bg" x1="128" y1="96" x2="896" y2="928" gradientUnits="userSpaceOnUse">
      <stop stop-color="#1C2230"/>
      <stop offset="1" stop-color="#0E131B"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(558 316) rotate(130.816) scale(641.999)">
      <stop stop-color="#41D1FF" stop-opacity="0.3"/>
      <stop offset="1" stop-color="#41D1FF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="bubble" x1="210" y1="238" x2="744" y2="760" gradientUnits="userSpaceOnUse">
      <stop stop-color="#79E0FF"/>
      <stop offset="1" stop-color="#31C48D"/>
    </linearGradient>
    <linearGradient id="mate" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#F5B971"/>
      <stop offset="1" stop-color="#EE6C4D"/>
    </linearGradient>
    <filter id="shadow" x="126" y="168" width="772" height="742" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"/>
      <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
      <feOffset dy="24"/>
      <feGaussianBlur stdDeviation="28"/>
      <feComposite in2="hardAlpha" operator="out"/>
      <feColorMatrix values="0 0 0 0 0.0313725 0 0 0 0 0.0666667 0 0 0 0 0.117647 0 0 0 0.42 0"/>
      <feBlend in2="BackgroundImageFix" result="effect1_dropShadow_0_1"/>
      <feBlend in="SourceGraphic" in2="effect1_dropShadow_0_1" result="shape"/>
    </filter>
  </defs>

  <rect x="72" y="72" width="880" height="880" rx="248" fill="url(#bg)"/>
  <rect x="72" y="72" width="880" height="880" rx="248" fill="url(#glow)"/>
  <rect x="108" y="108" width="808" height="808" rx="212" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <circle cx="746" cy="218" r="118" fill="#233043" opacity="0.55"/>
  <circle cx="324" cy="824" r="164" fill="#101720" opacity="0.76"/>

  <g filter="url(#shadow)">
    <path d="M266 232C224.026 232 190 266.026 190 308V564C190 605.974 224.026 640 266 640H432L545 776C562.193 796.696 596 784.537 596 757.632V640H670C711.974 640 746 605.974 746 564V308C746 266.026 711.974 232 670 232H266Z" fill="url(#bubble)"/>
    <path d="M266 232C224.026 232 190 266.026 190 308V564C190 605.974 224.026 640 266 640H432L545 776C562.193 796.696 596 784.537 596 757.632V640H670C711.974 640 746 605.974 746 564V308C746 266.026 711.974 232 670 232H266Z" stroke="rgba(255,255,255,0.18)" stroke-width="6"/>

    <circle cx="720" cy="300" r="122" fill="url(#mate)"/>
    <circle cx="720" cy="300" r="122" stroke="rgba(255,255,255,0.22)" stroke-width="6"/>
    <circle cx="720" cy="270" r="38" fill="#FFF6EA"/>
    <path d="M650 348C666.268 314.307 690.164 297.46 720 297.46C749.836 297.46 773.732 314.307 790 348V366H650V348Z" fill="#FFF6EA"/>
    <circle cx="768" cy="236" r="20" fill="rgba(255,255,255,0.32)"/>

    <path d="M418 388L330 468L418 548" stroke="#132132" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M520 360L472 576" stroke="#132132" stroke-width="42" stroke-linecap="round"/>
    <path d="M610 388L698 468L610 548" stroke="#132132" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/>

    <path d="M278 260L296.652 301.348L338 320L296.652 338.652L278 380L259.348 338.652L218 320L259.348 301.348L278 260Z" fill="#F4B942"/>
  </g>
</svg>`;

async function renderPng(size: number) {
  return sharp(Buffer.from(svg), { density: 144 })
    .resize(size, size)
    .png()
    .toBuffer();
}

async function main() {
  await mkdir(buildDir, { recursive: true });
  await writeFile(iconSvgPath, svg, "utf8");

  const iconPng = await renderPng(1024);
  await writeFile(iconPngPath, iconPng);

  const icoPngSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = await Promise.all(icoPngSizes.map((size) => renderPng(size)));
  const iconIco = await pngToIco(icoBuffers);
  await writeFile(iconIcoPath, iconIco);

  console.log("生成完了:", path.relative(repoRoot, iconSvgPath), path.relative(repoRoot, iconPngPath), path.relative(repoRoot, iconIcoPath));
}

void main();
