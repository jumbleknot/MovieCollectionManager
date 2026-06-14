# MCM Cinema Design System

**Material Design 3 · Tamagui · React Native + Web**

A design system for the Movie Collection Manager (MCM) universal app — targeting Android and web from a single Expo codebase. Components are MD3-compliant, built on Tamagui for cross-platform performance, and styled with a cinematic aesthetic that makes managing your movie collection feel as good as watching one.

---

## Visual Identity

### Philosophy

The MCM UI should feel like a premium home-theatre experience: clean, dark, and focused — with just enough personality to be fun. Orange appears rarely and intentionally, like the warm glow of a marquee light; it should never overwhelm.

### Colour

| Role | Light | Dark | Usage |
|---|---|---|---|
| **Primary** | `#1565C0` (Cinematic Blue) | `#A0C2FF` | Primary actions, AppBar, active states |
| **Secondary** | `#545F71` (Blue-Grey) | `#BBC7DB` | Supporting elements, nav active indicator |
| **Tertiary** ⚡ | `#BC3F00` (Grumpy Robot Orange) | `#FFB59A` | Accent only — rating stars, the Grumpy Robot avatar, and *attention* highlights such as a media/quality mismatch |
| **Surface** | `#FDFBFF` | `#0F1117` (Cinema Dark) | Backgrounds, cards |
| **Error** | `#B3261E` | `#F2B8B5` | Validation, HITL rejection |

**Rule: orange (tertiary) appears on at most 3–4 elements per screen.** Sanctioned uses are the Grumpy Robot avatar, rating stars, the single key **"Add movie"** call-to-action, and *attention* highlights — e.g. a movie whose **media format and rip quality don't match** gets an orange badge while matching values stay neutral. Do not use orange for text links, backgrounds, secondary buttons, or as a decorative tag on every 4K disc.

The dark theme background (`#0F1117`) is intentionally deeper than MD3's standard `#1A1C1E` — it evokes a cinema/home-theatre atmosphere and makes movie posters pop.

### Typography

| Scale | Font | Use in MCM |
|---|---|---|
| Display / Headline / Title | **Outfit** (400–700) | Screen titles, collection names, movie titles |
| Body / Label | **Inter** (400–500) | Metadata, descriptions, UI labels, chat |

Outfit's geometric character gives MCM a modern, slightly cinematic feel without being stylized. Inter ensures everything at small sizes (metadata, labels) stays perfectly legible on both screen types.

Install:
```bash
npx expo install expo-font @expo-google-fonts/outfit @expo-google-fonts/inter
```

### Grumpy Robot — The Movie Assistant

The Grumpy Robot is the visual identity of the `movie-assistant` AI agent. The robot head (orange `#E65100`, without text) appears as:

- The avatar in every chat bubble from the assistant
- The AssistantPanel header
- Animated with a "thinking" indicator (bouncing dots) while the agent processes
- The icon for the assistant tab in NavigationBar

The SVG implementation in `components/assistant/AssistantAvatar.tsx` recreates the logo programmatically — scalable, no image loading latency, works on all screen densities.

---

## Tokens

All tokens live in `design-system/tokens/`.

### Colour Tokens (`tokens/palette.ts`, `tokens/colors.ts`)

The palette defines 6 tonal palettes (primary, secondary, tertiary, error, neutral, neutralVariant), each with tones from 0 to 100. The `colors.ts` file maps these tones to MD3 semantic roles.

Access palette tones via Tamagui config: `$primaryP40`, `$tertiaryP50`, etc.
Access semantic roles via theme: `$primary`, `$onSurface`, `$tertiaryContainer`, etc.

### Spacing (`tokens/spacing.ts`)

4dp base grid. Reference via `$space.4` (= 16dp), `$space.6` (= 24dp), etc.

Key sizes:
- `$size.5` = 40dp — standard button/input height
- `$size.7` = 56dp — FAB, AppBar height
- `$size.8` = 64dp — large FAB, AppBar height (alternative)

### Shape / Radius (`tokens/spacing.ts` → `shapeScale`)

MD3 shape system — from `none` (0) to `full` (9999 = pill):

| Name | Value | Used for |
|---|---|---|
| extraSmall | 4dp | Menu items |
| small | 8dp | Chips, Snackbar |
| medium | 12dp | Cards |
| large | 16dp | Large dialogs |
| extraLarge | 28dp | FAB, bottom sheet |
| full | 9999dp | Buttons, SearchBar, pill chips |

### Elevation (`tokens/elevation.ts`)

5 MD3 levels. Each level provides:
- Android `elevation` dp value
- iOS shadow properties
- Surface tint key (see `surface1`–`surface5` in colour tokens)

| Level | dp | Used for |
|---|---|---|
| 0 | 0 | Flat surfaces, NavigationDrawer |
| 1 | 1 | Cards (resting), Chips |
| 2 | 3 | Cards (hovered), Menus |
| 3 | 6 | FAB, NavigationBar |
| 4 | 8 | FAB (hovered), AppBar (scrolled) |
| 5 | 12 | Dialogs |

### Motion (`tokens/motion.ts`)

MD3 motion system:

```ts
import { motion } from '@mcm/design-system'

// Duration
motion.duration.medium2   // 300ms — most transitions
motion.duration.long1     // 450ms — screen transitions

// Easing
motion.easingCSS.emphasized               // main transitions
motion.easingCSS.emphasizedDecelerate     // enter
motion.easingCSS.emphasizedAccelerate     // exit

// Pre-composed presets
motion.transitions.pageForward   // { duration: 350, easing: emphasizedDecelerate }
motion.transitions.dialogOpen    // { duration: 400, easing: emphasizedDecelerate }
motion.transitions.assistantOpen // { duration: 450, easing: emphasizedDecelerate }
```

---

## Tamagui Configuration

`design-system/tamagui.config.ts` is the entry point for Tamagui. Drop it in the root of `mcm-app/`:

```ts
// tamagui.config.ts (in mcm-app root)
export { default } from '@mcm/design-system/tamagui.config'
```

Then in `app/_layout.tsx`:
```tsx
import { TamaguiProvider } from 'tamagui'
import config from '../tamagui.config'
import { useFonts } from 'expo-font'
import { Outfit_400Regular, Outfit_500Medium, Outfit_700Bold } from '@expo-google-fonts/outfit'
import { Inter_400Regular, Inter_500Medium } from '@expo-google-fonts/inter'

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'Outfit': Outfit_400Regular,
    'Outfit-Medium': Outfit_500Medium,
    'Outfit-Bold': Outfit_700Bold,
    'Inter': Inter_400Regular,
    'Inter-Medium': Inter_500Medium,
  })

  if (!fontsLoaded) return null

  return (
    <TamaguiProvider config={config} defaultTheme="dark">
      <Stack />
    </TamaguiProvider>
  )
}
```

**The `dark` theme is the recommended default.** MCM is a movie collection app — dark mode is the natural home-theatre aesthetic.

---

## Component Reference

### Primitives

#### `Button`

```tsx
import { Button, FilledButton, OutlinedButton, TextButton } from '@mcm/design-system'

// 5 MD3 variants:
<Button variant="filled"      label="Add Movie"   onPress={handleAdd} />
<Button variant="filledTonal" label="Add to Wishlist" />
<Button variant="elevated"    label="Browse" />
<Button variant="outlined"    label="Cancel" />
<Button variant="text"        label="Learn more" />

// With icon:
<Button variant="filled" label="Add Movie" icon={<PlusIcon />} />

// Loading state:
<Button variant="filled" label="Saving…" loading />
```

#### `FAB`

The primary "Add Movie" action — uses the orange tertiary accent.

```tsx
import { FAB } from '@mcm/design-system'

// Standard FAB (56x56) — default colorScheme="tertiary" (orange)
<FAB variant="fab" icon={<PlusIcon />} label="Add movie" onPress={handleAdd} />

// Extended FAB (visible label)
<FAB variant="fabExtended" icon={<PlusIcon />} label="Add Movie" onPress={handleAdd} />

// Large FAB (96x96) — for empty state screens
<FAB variant="fabLarge" icon={<FilmIcon />} label="Start your collection" onPress={handleAdd} />
```

Position the FAB absolutely in screen layout:
```tsx
<Stack position="absolute" bottom={88} right={16}>
  <FAB variant="fabExtended" icon={<PlusIcon />} label="Add Movie" onPress={handleAdd} />
</Stack>
```

#### `Chip`

```tsx
import { Chip, ChipGroup } from '@mcm/design-system'

// Filter chips (genre filter bar)
<ChipGroup>
  <Chip type="filter" label="All"     selected={filter === 'all'}    onPress={() => setFilter('all')} />
  <Chip type="filter" label="Sci-Fi"  selected={filter === 'scifi'}  onPress={() => setFilter('scifi')} />
  <Chip type="filter" label="Drama"   selected={filter === 'drama'}  onPress={() => setFilter('drama')} />
</ChipGroup>

// Input chip (selected format tag)
<Chip type="input" label="4K UHD" onRemove={() => removeFormat('4K UHD')} />

// Assist chip
<Chip type="assist" label="Share collection" leadingIcon={<ShareIcon />} />
```

#### `Badge`

```tsx
import { Badge } from '@mcm/design-system'

// Dot (new item)
<Stack position="relative">
  <WishlistIcon />
  <Badge />  // dot badge
</Stack>

// Count
<Stack position="relative">
  <CollectionsIcon />
  <Badge count={3} />
  <Badge count={150} max={99} />  // shows "99+"
</Stack>
```

### Surfaces

#### `Card`

```tsx
import { Card } from '@mcm/design-system'

<Card variant="elevated" onPress={handlePress}>
  <Card.Media source={{ uri: posterUrl }} height={200} />
  <Card.Header
    title="Inception"
    subtitle="2010 · Christopher Nolan"
    trailing={<IconButton icon={<MoreIcon />} label="More options" />}
  />
  <Card.Content>
    <Text>A mind-bending thriller about dreams within dreams.</Text>
  </Card.Content>
  <Card.Actions>
    <TextButton label="Details" onPress={handleDetails} />
    <FilledButton label="Add to Collection" onPress={handleAdd} />
  </Card.Actions>
</Card>
```

#### `Dialog`

```tsx
import { Dialog } from '@mcm/design-system'

<Dialog
  visible={showDeleteDialog}
  title="Delete collection?"
  supportingText="All 47 movies in 'Sci-Fi Classics' will be permanently removed."
  actions={[
    <TextButton key="cancel" label="Cancel" onPress={() => setShowDeleteDialog(false)} />,
    <FilledButton key="delete" label="Delete" onPress={handleDelete} />,
  ]}
  onDismiss={() => setShowDeleteDialog(false)}
/>
```

#### `Snackbar`

```tsx
import { useSnackbar } from '@mcm/design-system'

function MyScreen() {
  const { showSnackbar, SnackbarHost } = useSnackbar()

  const handleAdd = async () => {
    await addMovie(movie)
    showSnackbar({
      message: 'Inception added to Sci-Fi Classics',
      action: { label: 'Undo', onPress: handleUndo },
    })
  }

  return (
    <Stack flex={1}>
      {/* screen content */}
      <SnackbarHost />
    </Stack>
  )
}
```

### Inputs

#### `TextField`

```tsx
import { TextField } from '@mcm/design-system'

<TextField
  variant="outlined"
  label="Movie title"
  value={title}
  onChangeText={setTitle}
  leadingIcon={<FilmIcon />}
  trailingIcon={<ClearIcon onPress={() => setTitle('')} />}
  supportingText="Enter the exact title as it appears on IMDB"
  maxCount={100}
  required
/>

<TextField
  variant="filled"
  label="Your rating"
  value={rating}
  onChangeText={setRating}
  keyboardType="numeric"
  error={!!ratingError}
  errorText="Rating must be between 0 and 10"
/>
```

#### `SearchBar`

```tsx
import { SearchBar } from '@mcm/design-system'

<SearchBar
  placeholder="Search your collection…"
  value={query}
  onChangeText={setQuery}
  onClear={() => setQuery('')}
  trailingIcon={<UserAvatar size={32} />}
/>
```

### Navigation

#### `AppBar`

```tsx
import { AppBar } from '@mcm/design-system'
import { useRef } from 'react'
import { Animated } from 'react-native'

function CollectionScreen() {
  const scrollY = useRef(new Animated.Value(0)).current

  return (
    <Stack flex={1}>
      <AppBar
        variant="large"
        title="Sci-Fi Classics"
        subtitle="47 movies"
        scrollY={scrollY}
        leading={<IconButton icon={<BackIcon />} label="Back" onPress={router.back} />}
        trailing={<>
          <IconButton icon={<SearchIcon />} label="Search" />
          <IconButton icon={<MoreIcon />}   label="More options" />
        </>}
      />
      <Animated.ScrollView
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false }
        )}
        scrollEventThrottle={16}
      >
        {/* content */}
      </Animated.ScrollView>
    </Stack>
  )
}
```

#### `NavigationBar`

```tsx
import { NavigationBar } from '@mcm/design-system'
import { useRouter, usePathname } from 'expo-router'

const destinations = [
  { key: '/',          label: 'Collections', icon: <GridIcon />,    activeIcon: <GridFilledIcon /> },
  { key: '/wishlist',  label: 'Wishlist',    icon: <HeartIcon />,   activeIcon: <HeartFilledIcon />, badge: 3 },
  { key: '/search',   label: 'Search',       icon: <SearchIcon />,  activeIcon: <SearchFilledIcon /> },
  { key: '/assistant',label: 'Assistant',    icon: <RobotIcon />,   activeIcon: <RobotFilledIcon /> },
]

function TabLayout() {
  const router   = useRouter()
  const pathname = usePathname()

  return (
    <Stack flex={1}>
      {/* screen content */}
      <NavigationBar
        destinations={destinations.map(d => ({ ...d, onPress: () => router.push(d.key) }))}
        activeKey={pathname}
      />
    </Stack>
  )
}
```

#### `Tabs`

```tsx
import { Tabs } from '@mcm/design-system'

<Tabs
  tabs={[
    { key: 'movies',   label: 'Movies'   },
    { key: 'details',  label: 'Details'  },
    { key: 'access',   label: 'Access'   },
  ]}
  activeKey={activeTab}
  onTabChange={setActiveTab}
  type="primary"
/>
```

### Domain Components

#### `MovieCard`

```tsx
import { MovieCard } from '@mcm/design-system'
import type { Movie } from '@mcm/design-system'

const movie: Movie = {
  id: '123',
  title: 'Blade Runner 2049',
  year: 2017,
  posterUrl: 'https://image.tmdb.org/…',
  runtime: 164,
  formats: ['4K UHD', 'Blu-ray'],
  rating: 8.5,
  inWishlist: false,
  director: 'Denis Villeneuve',
}

// Poster grid
<MovieCard movie={movie} layout="poster" onPress={() => router.push(`/movie/${movie.id}`)} />

// List row
<MovieCard movie={movie} layout="compact" onPress={…} onWishlistToggle={…} />
```

**`FormatBadge` colouring:** badges are neutral by default. Pass `highlight` (or let the data-table compute it) to render the orange *tertiary* badge — used when a title's **media** and **rip quality** disagree, so the discrepancy stands out. Do **not** colour a badge just because the format is 4K/UHD.

**Data table (web):** the collection/import table places the result count and the **orange "Add movie"** call-to-action in a toolbar bar inside the table card header. Column headers use Outfit 700, full on-surface contrast, and a 2dp primary bottom-border to separate them clearly from rows.

#### `CollectionCard`

```tsx
import { CollectionCard } from '@mcm/design-system'

<CollectionCard
  collection={{
    id: 'abc',
    name: 'Sci-Fi Classics',
    movieCount: 47,
    posterUrls: [url1, url2, url3],
    role: 'owner',
    isDefault: true,
  }}
  variant="grid"
  onPress={() => router.push(`/collection/${collection.id}`)}
/>
```

### Assistant Components

#### `AssistantAvatar`

```tsx
import { AssistantAvatar } from '@mcm/design-system'

// In chat bubble
<AssistantAvatar size="sm" />

// Panel header
<AssistantAvatar size="lg" />

// Thinking/processing state
<AssistantAvatar size="md" thinking={isAgentProcessing} />

// Sizes: 'xs'=24, 'sm'=32, 'md'=40, 'lg'=56, 'xl'=80
```

#### `ChatBubble`

```tsx
import { ChatBubble, ApprovalBubble } from '@mcm/design-system'

// User message
<ChatBubble sender="user" message="Add Blade Runner 2049 to my Sci-Fi collection" timestamp={new Date()} />

// Assistant response with text
<ChatBubble sender="assistant" message="Found Blade Runner 2049 (2017). Add it to Sci-Fi Classics?" timestamp={new Date()} />

// Assistant response with generative UI
<ChatBubble sender="assistant" message="Here's what I found:">
  <MovieCard movie={foundMovie} layout="compact" onPress={handleMoviePress} />
</ChatBubble>

// Typing indicator
<ChatBubble sender="assistant" thinking={true} />

// HITL approval card
<ApprovalBubble
  title="Add to Collection"
  description="Add Blade Runner 2049 (2017) to Sci-Fi Classics (47 → 48 movies)?"
  onApprove={handleApprove}
  onReject={handleReject}
  loading={isPendingApproval}
/>
```

#### `AssistantPanel`

```tsx
import { AssistantPanel } from '@mcm/design-system'

// Wire up to CopilotKit in mcm-app.
// Use this as the visual shell; CopilotKit manages the agent connection.

function AssistantScreen() {
  const [messages, setMessages] = useState<Message[]>([])
  const [isThinking, setThinking] = useState(false)

  const handleSend = async (text: string) => {
    // Add user message
    setMessages(prev => [...prev, { id: uuid(), sender: 'user', text, timestamp: new Date() }])
    setThinking(true)
    // … CopilotKit sends to BFF → agent → back
    setThinking(false)
  }

  return (
    <AssistantPanel
      messages={messages}
      onSend={handleSend}
      isThinking={isThinking}
      onClose={() => router.back()}
    />
  )
}
```

---

## File Structure

```
design-system/
├── package.json
├── index.ts                    ← public API barrel
├── tamagui.config.ts           ← main Tamagui config
│
├── tokens/
│   ├── palette.ts              ← raw tonal palettes (0–100)
│   ├── colors.ts               ← MD3 semantic roles (lightColors, darkColors)
│   ├── typography.ts           ← type scale + Tamagui font size tokens
│   ├── spacing.ts              ← space, size, radius, zIndex tokens
│   ├── elevation.ts            ← MD3 elevation levels + component map
│   └── motion.ts               ← duration, easing, transition presets
│
├── fonts/
│   └── index.ts                ← outfitFont, interFont (createFont)
│
├── theme/
│   ├── light.ts                ← light theme (MD3 light roles)
│   ├── dark.ts                 ← dark theme (Cinema Dark: #0F1117)
│   └── index.ts
│
└── components/
    ├── primitives/
    │   ├── Button.tsx           ← 5 variants (filled, tonal, elevated, outlined, text)
    │   ├── IconButton.tsx       ← 4 variants + toggle
    │   ├── FAB.tsx              ← fab, fabSmall, fabLarge, fabExtended
    │   ├── Chip.tsx             ← assist, filter, input, suggestion + ChipGroup
    │   ├── Badge.tsx            ← dot + count
    │   ├── Divider.tsx          ← full, inset, middle
    │   └── index.ts
    ├── inputs/
    │   ├── TextField.tsx        ← filled + outlined, floating label, validation
    │   ├── SearchBar.tsx        ← docked + full variants
    │   ├── Switch.tsx           ← animated MD3 switch
    │   └── index.ts
    ├── surfaces/
    │   ├── Card.tsx             ← elevated, filled, outlined + Header/Media/Content/Actions
    │   ├── Dialog.tsx           ← MD3 dialog with scrim
    │   ├── Snackbar.tsx         ← slide-up + useSnackbar hook
    │   └── index.ts
    ├── navigation/
    │   ├── AppBar.tsx           ← centerAligned, small, medium, large + scroll collapse
    │   ├── NavigationBar.tsx    ← 3–5 destinations, animated indicator
    │   ├── Tabs.tsx             ← primary + secondary, scrollable
    │   └── index.ts
    ├── domain/
    │   ├── MovieCard.tsx        ← poster, compact layouts + StarRating, FormatBadge
    │   ├── CollectionCard.tsx   ← grid + row, poster mosaic, role chip
    │   └── index.ts
    └── assistant/
        ├── AssistantAvatar.tsx  ← Grumpy Robot SVG, thinking animation
        ├── ChatBubble.tsx       ← user/assistant/system + ApprovalBubble (HITL)
        ├── AssistantPanel.tsx   ← full conversation shell (CopilotKit wrapper)
        └── index.ts
```

---

## Installation in mcm-app

1. **Add the design system as a workspace package** (assuming Nx/pnpm monorepo):

   ```json
   // mcm-app/package.json
   {
     "dependencies": {
       "@mcm/design-system": "workspace:*"
     }
   }
   ```

2. **Install Expo dependencies:**

   ```bash
   npx expo install tamagui @tamagui/core @tamagui/config
   npx expo install expo-font @expo-google-fonts/outfit @expo-google-fonts/inter
   npx expo install react-native-svg
   npx expo install react-native-safe-area-context
   ```

3. **Configure Metro bundler** (`metro.config.js`):

   ```js
   // Tamagui requires this for tree-shaking
   const { withTamagui } = require('@tamagui/metro-plugin')
   module.exports = withTamagui(config, { components: ['tamagui'], config: './tamagui.config.ts' })
   ```

4. **Set up Babel** (`babel.config.js`):

   ```js
   module.exports = {
     presets: ['babel-preset-expo'],
     plugins: [
       ['@tamagui/babel-plugin', { components: ['tamagui'], config: './tamagui.config.ts' }],
     ],
   }
   ```

5. **Wrap your app** in `app/_layout.tsx` (see configuration section above).

---

## Design Principles

1. **Cinema-first dark mode** — dark is the default; light mode is the secondary option, not the afterthought.

2. **Orange as punctuation, not prose** — tertiary/orange appears on max 3–4 elements per screen. Rating stars, the robot avatar, and *attention/discrepancy* highlights (e.g. a media↔quality mismatch badge) are the blessed uses. Matching/normal values stay neutral, and primary actions stay blue.

3. **Touch-first, pointer-friendly** — all interactive elements meet the 48x48dp minimum touch target. On web, hover states and focus rings make keyboard/pointer use feel premium.

4. **Elevation = depth** — cards, FABs, and panels use real shadow + surface tint to communicate layering. Flat surfaces are for background; important surfaces have dimension.

5. **The robot has personality** — the Grumpy Robot avatar uses orange prominently and intentionally. It's the exception that proves the rule: a character can be expressive; the UI framework around it stays restrained.

6. **State layers, not opacity hacks** — hover, press, and focus states use MD3 state layers (8%, 12%, 12% tint) rather than `opacity` changes, which avoids parent transparency bleed.

7. **Motion is purposeful** — use emphasized easing for elements traversing large areas (page transitions, bottom sheet open); standard easing for component-level changes (button press, chip toggle).

---

## MD3 Compliance Notes

This design system implements the following MD3 components from the M3 specification (https://m3.material.io):

- ✅ Buttons (all 5 variants)
- ✅ Icon Button (all 4 variants + toggle)
- ✅ FAB (all 4 sizes)
- ✅ Chips (all 4 types)
- ✅ Badge (dot + count)
- ✅ Card (all 3 variants)
- ✅ Dialog
- ✅ Snackbar
- ✅ Text Field (filled + outlined with floating label)
- ✅ Search Bar
- ✅ Switch
- ✅ Top App Bar (all 4 variants with scroll collapse)
- ✅ Navigation Bar (with animated indicator)
- ✅ Tabs (primary + secondary with animated indicator)
- ✅ Divider (full, inset, middle)
- ✅ Color system (tonal palettes, semantic roles, surface tones)
- ✅ Typography scale (MD3 type roles → Tamagui font tokens)
- ✅ Elevation system (5 levels, shadow + surface tint)
- ✅ Motion system (duration tokens, easing curves, transition presets)
- ✅ Shape system (MD3 shape roles → Tamagui radius tokens)
- ✅ State layers (hover 8%, press 12%, focus 12%)
- ✅ Minimum touch target 48x48dp enforcement
- ✅ Accessibility (accessibilityRole, accessibilityLabel, accessibilityState)

Not yet implemented (future):
- ⏳ Bottom Sheet
- ⏳ Date Picker
- ⏳ Time Picker
- ⏳ Slider
- ⏳ Progress Indicators (linear, circular)
- ⏳ Tooltip
- ⏳ Navigation Drawer
- ⏳ Menu / Dropdown
