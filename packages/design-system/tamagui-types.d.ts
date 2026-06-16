// Tamagui type augmentation intentionally omitted.
//
// `declare module 'tamagui' { interface TamaguiCustomConfig extends typeof config }`
// creates a createTamagui ↔ TamaguiCustomConfig ↔ typeof config self-reference that the
// repo's bleeding-edge TypeScript rejects (TS7022/TS2456) once the whole component tree is
// type-checked together. The augmentation is type-only (no runtime effect): Tamagui's
// `useTheme()` is already permissively typed, so theme access (`theme.x?.val`) and token
// strings (`$heading`, `$9`) compile without it. Omitting it trades some token autocomplete
// for a clean strict build. Re-introduce via a project-reference/declaration-emit boundary
// if richer token typing is wanted later.
export {};
