# MCM Android Adaptive Icon (from v11 clapper-shelf)

Background color: **#11151F** (Cinema navy) - the foreground is transparent; the launcher composites it over this color and applies its own mask (circle / squircle / rounded-square / teardrop).

## If you use Expo (recommended for this project)
Copy the three files in `expo-assets/` into your app's `assets/` folder and merge `app.json.snippet` into your config. `npx expo prebuild` regenerates all native densities.

## If you manage native Android directly
Copy `res/` into `android/app/src/main/res/`, merging with what's there:
- `mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml` -> adaptive-icon definition (background color + foreground + monochrome).
- `mipmap-*/ic_launcher_foreground.png` (108dp): 108 / 162 / 216 / 324 / 432 px.
- `mipmap-*/ic_launcher_monochrome.png` (108dp): themed-icon layer, Android 13+.
- `mipmap-*/ic_launcher.png` + `ic_launcher_round.png` (48dp legacy fallback): 48 / 72 / 96 / 144 / 192 px.
- `values/colors.xml` -> `ic_launcher_background` = #11151F.

## Play Store
`play-store-icon-512.png` - 512x512 hi-res listing icon.

All icon content sits within the adaptive safe zone (inner 66%), so nothing important is cropped by any launcher mask.
