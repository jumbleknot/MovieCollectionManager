/**
 * MovieForm component (T100)
 *
 * Shared form for adding and editing a movie.
 * In "create" mode: renders blank inputs with spec-mandated defaults (FR-012).
 * In "edit" mode: pre-fills all inputs from initialValues (Movie).
 *
 * Required fields: title, year, contentType, language, owned, ripped, childrens
 * Conditional fields:
 *   - ownedMedia: shown only when owned=true; cleared when owned→false
 *   - ripQuality: shown only when ripped=true; cleared when ripped→false
 * Optional fields: rated, originalTitle, releaseDate, outline, plot, runtime,
 *   directors, actors, movieSet, tags, genres, externalIds
 *
 * Validation:
 *   - title required
 *   - year required (numeric, 4-digit)
 *   - language required
 *   - contentType must be 'Movie' | 'Series' | 'Concert'
 *   - owned media must be empty when owned=false
 *   - rip quality must be empty when ripped=false
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Switch,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button, Chip } from '@mcm/design-system';
import { NoAutoFillInput } from '@/components/no-autofill-input';
import type {
  Movie,
  CreateMovieRequest,
  ContentType,
  MediaFormat,
  UsaRating,
  ExternalId,
} from '@/types/collection';

type MovieFormMode = 'create' | 'edit';

interface MovieFormProps {
  mode: MovieFormMode;
  initialValues?: Movie;
  onSubmit: (values: CreateMovieRequest) => Promise<void>;
  onCancel: () => void;
  isLoading?: boolean;
  /** Server-side error message to display (e.g. duplicate movie, invalid value). */
  serverError?: string | null;
}

// ─── Controlled vocabularies (spec FR-011, FR-013) ────────────────────────────

const CONTENT_TYPES: ContentType[] = ['Movie', 'Series', 'Concert'];

// Spec FR-013 + mc-service domain::MediaFormat
const MEDIA_FORMATS: MediaFormat[] = ['DVD', 'Blu-Ray', 'Blu-Ray 3D', 'UHD Blu-Ray'];

// Spec clarification 2026-05-22 — rip quality uses the same value set as owned media
const RIP_QUALITIES: MediaFormat[] = ['DVD', 'Blu-Ray', 'Blu-Ray 3D', 'UHD Blu-Ray'];

// Spec clarification 2026-05-22 — USA rating controlled vocabulary
const USA_RATINGS: UsaRating[] = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR', 'Unrated'];

// ─── ExternalId draft state ────────────────────────────────────────────────────

interface ExternalIdDraft {
  system: string;
  uniqueId: string;
  url: string;
}

const emptyDraft = (): ExternalIdDraft => ({ system: '', uniqueId: '', url: '' });

// ─── Component ────────────────────────────────────────────────────────────────

export function MovieForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isLoading = false,
  serverError,
}: MovieFormProps): React.JSX.Element {
  // Required fields
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [year, setYear] = useState(initialValues?.year?.toString() ?? '');
  const [contentType, setContentType] = useState<ContentType>(
    initialValues?.contentType ?? 'Movie',
  );
  const [language, setLanguage] = useState(initialValues?.language ?? '');
  const [owned, setOwned] = useState(initialValues?.owned ?? false);
  const [ripped, setRipped] = useState(initialValues?.ripped ?? false);
  const [childrens, setChildrens] = useState(initialValues?.childrens ?? false);

  // Conditional fields
  const [ownedMedia, setOwnedMedia] = useState<MediaFormat[]>(
    initialValues?.ownedMedia ?? [],
  );
  const [ripQuality, setRipQuality] = useState<MediaFormat[]>(
    initialValues?.ripQuality ?? [],
  );

  // Optional fields — single-value
  const [rated, setRated] = useState<UsaRating | null>(initialValues?.rated ?? null);
  const [originalTitle, setOriginalTitle] = useState(initialValues?.originalTitle ?? '');
  const [releaseDate, setReleaseDate] = useState(initialValues?.releaseDate ?? '');
  const [outline, setOutline] = useState(initialValues?.outline ?? '');
  const [plot, setPlot] = useState(initialValues?.plot ?? '');
  const [runtime, setRuntime] = useState(
    initialValues?.runtime != null ? String(initialValues.runtime) : '',
  );
  const [movieSet, setMovieSet] = useState(initialValues?.movieSet ?? '');

  // Optional fields — multi-value text arrays
  const [directors, setDirectors] = useState<string[]>(initialValues?.directors ?? []);
  const [newDirector, setNewDirector] = useState('');

  const [actors, setActors] = useState<string[]>(initialValues?.actors ?? []);
  const [newActor, setNewActor] = useState('');

  const [tags, setTags] = useState<string[]>(initialValues?.tags ?? []);
  const [newTag, setNewTag] = useState('');

  const [genres, setGenres] = useState<string[]>(initialValues?.genres ?? []);
  const [newGenre, setNewGenre] = useState('');

  // Optional fields — external IDs
  const [externalIds, setExternalIds] = useState<ExternalId[]>(
    initialValues?.externalIds ?? [],
  );
  const [extIdDraft, setExtIdDraft] = useState<ExternalIdDraft>(emptyDraft());

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  const theme = useTheme();
  const styles = makeStyles(theme);

  // ─── Validation ─────────────────────────────────────────────────────────────

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = 'Title is required.';
    if (!year.trim()) {
      e.year = 'Year is required.';
    } else if (!/^\d{4}$/.test(year.trim())) {
      e.year = 'Year must be a 4-digit number.';
    }
    // Language is optional (014 US1) — no required check.
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ─── Submit ─────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!validate()) return;

    const payload: CreateMovieRequest = {
      title: title.trim(),
      year: parseInt(year.trim(), 10),
      contentType,
      language: language.trim() || null,
      owned,
      ripped,
      childrens,
      ownedMedia: owned ? ownedMedia : [],
      ripQuality: ripped ? ripQuality : [],
      rated: rated ?? null,
      originalTitle: originalTitle.trim() || null,
      releaseDate: releaseDate.trim() || null,
      outline: outline.trim() || null,
      plot: plot.trim() || null,
      runtime: runtime.trim() ? parseInt(runtime.trim(), 10) : null,
      movieSet: movieSet.trim() || null,
      directors,
      actors,
      tags,
      genres,
      externalIds,
    };

    await onSubmit(payload);
  };

  // ─── Conditional field handlers ──────────────────────────────────────────────

  const handleOwnedChange = (value: boolean) => {
    setOwned(value);
    if (!value) setOwnedMedia([]);
  };

  const handleRippedChange = (value: boolean) => {
    setRipped(value);
    if (!value) setRipQuality([]);
  };

  const toggleMediaFormat = (fmt: MediaFormat) =>
    setOwnedMedia(prev => prev.includes(fmt) ? prev.filter(f => f !== fmt) : [...prev, fmt]);

  const toggleRipQuality = (q: MediaFormat) =>
    setRipQuality(prev => prev.includes(q) ? prev.filter(r => r !== q) : [...prev, q]);

  // ─── Multi-value list helpers ────────────────────────────────────────────────

  const addItem = (
    value: string,
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    inputSetter: React.Dispatch<React.SetStateAction<string>>,
  ) => {
    const v = value.trim();
    if (!v) return;
    setter(prev => (prev.includes(v) ? prev : [...prev, v]));
    inputSetter('');
  };

  const removeItem = (
    value: string,
    setter: React.Dispatch<React.SetStateAction<string[]>>,
  ) => setter(prev => prev.filter(i => i !== value));

  // ─── External ID helpers ─────────────────────────────────────────────────────

  const addExternalId = () => {
    const { system, uniqueId, url } = extIdDraft;
    if (!system.trim() || !uniqueId.trim()) return;
    setExternalIds(prev => [
      ...prev,
      { system: system.trim(), uniqueId: uniqueId.trim(), url: url.trim() || null },
    ]);
    setExtIdDraft(emptyDraft());
  };

  const removeExternalId = (idx: number) =>
    setExternalIds(prev => prev.filter((_, i) => i !== idx));

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={styles.formContainer}>
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >

      {/* Server error banner */}
      {!!serverError && (
        <View style={styles.serverErrorBanner} testID="movie-form-server-error">
          <Text style={styles.serverErrorText}>{serverError}</Text>
        </View>
      )}

      {/* ── REQUIRED FIELDS ──────────────────────────────────────────────────── */}

      {/* Title */}
      <Text style={styles.label}>Title *</Text>
      <NoAutoFillInput
        style={[styles.input, errors.title ? styles.inputError : null]}
        value={title}
        onChangeText={text => { setTitle(text); setErrors(e => ({ ...e, title: '' })); }}
        placeholder="Movie title"
        testID="movie-form-title-input"
        accessibilityLabel="Movie title"
      />
      {!!errors.title && (
        <Text style={styles.errorText} testID="movie-form-title-error">{errors.title}</Text>
      )}

      {/* Year */}
      <Text style={styles.label}>Year *</Text>
      <NoAutoFillInput
        style={[styles.input, errors.year ? styles.inputError : null]}
        value={year}
        onChangeText={text => { setYear(text); setErrors(e => ({ ...e, year: '' })); }}
        placeholder="e.g. 1999"
        keyboardType="numeric"
        maxLength={4}
        testID="movie-form-year-input"
        accessibilityLabel="Release year"
        // Chrome ignores autocomplete="off" on a 4-digit numeric field (treats it like a
        // credit-card-expiry year) and offers autofill; a non-standard `name` defeats that heuristic.
        webName="movie-year"
      />
      {!!errors.year && (
        <Text style={styles.errorText} testID="movie-form-year-error">{errors.year}</Text>
      )}

      {/* Content Type */}
      <Text style={styles.label}>Content Type *</Text>
      <View style={styles.radioGroup} testID="movie-form-content-type-picker">
        {CONTENT_TYPES.map(ct => ( // ds-exempt(R4): sanctioned radio selector — native picker crashes on Android Fabric
          <TouchableOpacity
            key={ct}
            style={[styles.radioButton, contentType === ct && styles.radioButtonSelected]}
            onPress={() => setContentType(ct)}
            testID={`movie-form-content-type-${ct.toLowerCase()}`}
            accessibilityRole="radio"
            accessibilityLabel={ct}
            accessibilityState={{ selected: contentType === ct }}
          >
            <Text style={[styles.radioText, contentType === ct && styles.radioTextSelected]}>
              {ct}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Language (optional — 014 US1) */}
      <Text style={styles.label}>Language</Text>
      <NoAutoFillInput
        style={styles.input}
        value={language}
        onChangeText={setLanguage}
        placeholder="e.g. English (optional)"
        testID="movie-form-language-input"
        accessibilityLabel="Language"
      />
      <Text style={styles.helperText} testID="movie-form-language-helper">
        Leave blank if the language is unknown.
      </Text>

      {/* Owned */}
      <View style={styles.toggleRow}>
        <Text style={styles.label}>Owned</Text>
        <Switch
          value={owned}
          onValueChange={handleOwnedChange}
          testID="movie-form-owned-toggle"
          accessibilityLabel="Owned"
        />
      </View>

      {/* Owned Media (conditional) */}
      {owned && (
        <View testID="movie-form-owned-media-picker">
          <Text style={styles.label}>Owned Media</Text>
          <View style={styles.chipRow}>
            {MEDIA_FORMATS.map(fmt => (
              <Chip
                key={fmt}
                type="filter"
                selectedScheme="primary"
                selected={ownedMedia.includes(fmt)}
                label={fmt}
                onPress={() => toggleMediaFormat(fmt)}
                testID={`movie-form-owned-media-${fmt.toLowerCase().replace(/ /g, '-')}`}
                accessibilityLabel={fmt}
              />
            ))}
          </View>
        </View>
      )}

      {/* Ripped */}
      <View style={styles.toggleRow}>
        <Text style={styles.label}>Ripped</Text>
        <Switch
          value={ripped}
          onValueChange={handleRippedChange}
          testID="movie-form-ripped-toggle"
          accessibilityLabel="Ripped"
        />
      </View>

      {/* Rip Quality (conditional) */}
      {ripped && (
        <View testID="movie-form-rip-quality-picker">
          <Text style={styles.label}>Rip Quality</Text>
          <View style={styles.chipRow}>
            {RIP_QUALITIES.map(q => (
              <Chip
                key={q}
                type="filter"
                selectedScheme="primary"
                selected={ripQuality.includes(q)}
                label={q}
                onPress={() => toggleRipQuality(q)}
                testID={`movie-form-rip-quality-${q.toLowerCase().replace(/ /g, '-')}`}
                accessibilityLabel={q}
              />
            ))}
          </View>
        </View>
      )}

      {/* Children's */}
      <View style={styles.toggleRow}>
        <Text style={styles.label}>Children's</Text>
        <Switch
          value={childrens}
          onValueChange={setChildrens}
          testID="movie-form-childrens-toggle"
          accessibilityLabel="Children's content"
        />
      </View>

      {/* ── OPTIONAL FIELDS ───────────────────────────────────────────────────── */}

      <Text style={styles.sectionHeader}>Optional Details</Text>

      {/* USA Rating */}
      <Text style={styles.label}>USA Rating</Text>
      <View style={styles.radioGroup} testID="movie-form-rated-picker">
        {/* ds-exempt(R4): sanctioned radio selector — native picker crashes on Android Fabric (see contracts/sanctioned-deviations.md). */}
        <TouchableOpacity
          style={[styles.radioButton, rated === null && styles.radioButtonSelected]}
          onPress={() => setRated(null)}
          testID="movie-form-rated-none"
          accessibilityRole="radio"
          accessibilityLabel="None"
          accessibilityState={{ selected: rated === null }}
        >
          <Text style={[styles.radioText, rated === null && styles.radioTextSelected]}>None</Text>
        </TouchableOpacity>
        {USA_RATINGS.map(r => ( // ds-exempt(R4): sanctioned radio selector — native picker crashes on Android Fabric
          <TouchableOpacity
            key={r}
            style={[styles.radioButton, rated === r && styles.radioButtonSelected]}
            onPress={() => setRated(r)}
            testID={`movie-form-rated-${r.toLowerCase().replace(/-/g, '')}`}
            accessibilityRole="radio"
            accessibilityLabel={r}
            accessibilityState={{ selected: rated === r }}
          >
            <Text style={[styles.radioText, rated === r && styles.radioTextSelected]}>{r}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Original Title */}
      <Text style={styles.label}>Original Title</Text>
      <NoAutoFillInput
        style={styles.input}
        value={originalTitle}
        onChangeText={setOriginalTitle}
        placeholder="Original release title"
        testID="movie-form-original-title-input"
        accessibilityLabel="Original title"
      />

      {/* Release Date */}
      <Text style={styles.label}>Release Date (YYYY-MM-DD)</Text>
      <NoAutoFillInput
        style={styles.input}
        value={releaseDate}
        onChangeText={setReleaseDate}
        placeholder="e.g. 1999-03-31"
        testID="movie-form-release-date-input"
        accessibilityLabel="Release date"
      />

      {/* Runtime */}
      <Text style={styles.label}>Runtime (minutes)</Text>
      <NoAutoFillInput
        style={styles.input}
        value={runtime}
        onChangeText={setRuntime}
        placeholder="e.g. 136"
        keyboardType="numeric"
        testID="movie-form-runtime-input"
        accessibilityLabel="Runtime in minutes"
      />

      {/* Movie Set */}
      <Text style={styles.label}>Movie Set</Text>
      <NoAutoFillInput
        style={styles.input}
        value={movieSet}
        onChangeText={setMovieSet}
        placeholder="e.g. The Matrix Collection"
        testID="movie-form-movie-set-input"
        accessibilityLabel="Movie set"
      />

      {/* Outline */}
      <Text style={styles.label}>Outline</Text>
      <NoAutoFillInput
        style={[styles.input, styles.multiline]}
        value={outline}
        onChangeText={setOutline}
        placeholder="Brief summary"
        multiline
        numberOfLines={2}
        testID="movie-form-outline-input"
        accessibilityLabel="Outline"
      />

      {/* Plot */}
      <Text style={styles.label}>Plot</Text>
      <NoAutoFillInput
        style={[styles.input, styles.multiline]}
        value={plot}
        onChangeText={setPlot}
        placeholder="Full plot description"
        multiline
        numberOfLines={4}
        testID="movie-form-plot-input"
        accessibilityLabel="Plot"
      />

      {/* Directors */}
      <Text style={styles.label}>Directors</Text>
      <View style={styles.addRow}>
        <NoAutoFillInput
          style={[styles.input, styles.addInput]}
          value={newDirector}
          onChangeText={setNewDirector}
          placeholder="Add director"
          testID="movie-form-director-input"
          accessibilityLabel="Add director"
          onSubmitEditing={() => addItem(newDirector, setDirectors, setNewDirector)}
          webName="director-entry"
        />
        <Button
          variant="filledTonal"
          size="sm"
          label="Add"
          onPress={() => addItem(newDirector, setDirectors, setNewDirector)}
          testID="movie-form-director-add-button"
          accessibilityLabel="Add director"
        />
      </View>
      <View style={styles.chipRow} testID="movie-form-directors-list">
        {directors.map(d => (
          <View key={d} style={styles.chipWithRemove}>
            <Text style={styles.chipText}>{d}</Text>
            <TouchableOpacity
              onPress={() => removeItem(d, setDirectors)}
              testID={`movie-form-director-remove-${d}`}
              accessibilityRole="button"
              accessibilityLabel={`Remove director ${d}`}
            >
              <Text style={styles.removeText}>×</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {/* Actors */}
      <Text style={styles.label}>Actors</Text>
      <View style={styles.addRow}>
        <NoAutoFillInput
          style={[styles.input, styles.addInput]}
          value={newActor}
          onChangeText={setNewActor}
          placeholder="Add actor"
          testID="movie-form-actor-input"
          accessibilityLabel="Add actor"
          onSubmitEditing={() => addItem(newActor, setActors, setNewActor)}
          webName="actor-entry"
        />
        <Button
          variant="filledTonal"
          size="sm"
          label="Add"
          onPress={() => addItem(newActor, setActors, setNewActor)}
          testID="movie-form-actor-add-button"
          accessibilityLabel="Add actor"
        />
      </View>
      <View style={styles.chipRow} testID="movie-form-actors-list">
        {actors.map(a => (
          <View key={a} style={styles.chipWithRemove}>
            <Text style={styles.chipText}>{a}</Text>
            <TouchableOpacity
              onPress={() => removeItem(a, setActors)}
              testID={`movie-form-actor-remove-${a}`}
              accessibilityRole="button"
              accessibilityLabel={`Remove actor ${a}`}
            >
              <Text style={styles.removeText}>×</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {/* Genres */}
      <Text style={styles.label}>Genres</Text>
      <View style={styles.addRow}>
        <NoAutoFillInput
          style={[styles.input, styles.addInput]}
          value={newGenre}
          onChangeText={setNewGenre}
          placeholder="e.g. Action"
          testID="movie-form-genre-input"
          accessibilityLabel="Add genre"
          onSubmitEditing={() => addItem(newGenre, setGenres, setNewGenre)}
        />
        <Button
          variant="filledTonal"
          size="sm"
          label="Add"
          onPress={() => addItem(newGenre, setGenres, setNewGenre)}
          testID="movie-form-genre-add-button"
          accessibilityLabel="Add genre"
        />
      </View>
      <View style={styles.chipRow} testID="movie-form-genres-list">
        {genres.map(g => (
          <View key={g} style={styles.chipWithRemove}>
            <Text style={styles.chipText}>{g}</Text>
            <TouchableOpacity
              onPress={() => removeItem(g, setGenres)}
              testID={`movie-form-genre-remove-${g}`}
              accessibilityRole="button"
              accessibilityLabel={`Remove genre ${g}`}
            >
              <Text style={styles.removeText}>×</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {/* Tags */}
      <Text style={styles.label}>Tags</Text>
      <View style={styles.addRow}>
        <NoAutoFillInput
          style={[styles.input, styles.addInput]}
          value={newTag}
          onChangeText={setNewTag}
          placeholder="e.g. classic"
          testID="movie-form-tag-input"
          accessibilityLabel="Add tag"
          onSubmitEditing={() => addItem(newTag, setTags, setNewTag)}
        />
        <Button
          variant="filledTonal"
          size="sm"
          label="Add"
          onPress={() => addItem(newTag, setTags, setNewTag)}
          testID="movie-form-tag-add-button"
          accessibilityLabel="Add tag"
        />
      </View>
      <View style={styles.chipRow} testID="movie-form-tags-list">
        {tags.map(t => (
          <View key={t} style={styles.chipWithRemove}>
            <Text style={styles.chipText}>{t}</Text>
            <TouchableOpacity
              onPress={() => removeItem(t, setTags)}
              testID={`movie-form-tag-remove-${t}`}
              accessibilityRole="button"
              accessibilityLabel={`Remove tag ${t}`}
            >
              <Text style={styles.removeText}>×</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {/* External IDs */}
      <Text style={styles.label}>External IDs</Text>
      <View testID="movie-form-external-ids-section">
        {externalIds.map((eid, idx) => (
          <View key={idx} style={styles.externalIdRow}>
            <Text style={styles.externalIdText}>
              {eid.system}: {eid.uniqueId}
              {eid.url ? ` (${eid.url})` : ''}
            </Text>
            <TouchableOpacity
              onPress={() => removeExternalId(idx)}
              testID={`movie-form-ext-id-remove-${idx}`}
              accessibilityRole="button"
              accessibilityLabel={`Remove external ID ${eid.system}`}
            >
              <Text style={styles.removeText}>×</Text>
            </TouchableOpacity>
          </View>
        ))}
        <NoAutoFillInput
          style={styles.input}
          value={extIdDraft.system}
          onChangeText={v => setExtIdDraft(d => ({ ...d, system: v }))}
          placeholder="System (e.g. IMDB)"
          testID="movie-form-ext-id-system-input"
          accessibilityLabel="External ID system"
          webName="ext-id-system"
        />
        <NoAutoFillInput
          style={styles.input}
          value={extIdDraft.uniqueId}
          onChangeText={v => setExtIdDraft(d => ({ ...d, uniqueId: v }))}
          placeholder="e.g. tt0133093"
          testID="movie-form-ext-id-unique-input"
          accessibilityLabel="External reference"
          webName="ext-id-unique"
        />
        <NoAutoFillInput
          style={styles.input}
          value={extIdDraft.url}
          onChangeText={v => setExtIdDraft(d => ({ ...d, url: v }))}
          placeholder="URL (optional)"
          testID="movie-form-ext-id-url-input"
          accessibilityLabel="External ID URL"
        />
        <Button
          variant="filledTonal"
          size="sm"
          label="Add External ID"
          onPress={addExternalId}
          testID="movie-form-ext-id-add-button"
          accessibilityLabel="Add external ID"
          alignSelf="flex-start"
        />
      </View>

    </ScrollView>

    {/* ── ACTIONS (fixed footer — always visible regardless of scroll/keyboard) ── */}
    <View style={styles.actionsFooter}>
      <Button
        variant="outlined"
        label="Cancel"
        onPress={onCancel}
        testID="movie-form-cancel-button"
        accessibilityLabel="Cancel"
        disabled={isLoading}
      />
      <Button
        variant="filled"
        label={mode === 'create' ? 'Add Movie' : 'Save'}
        onPress={() => { void handleSubmit(); }}
        loading={isLoading}
        disabled={isLoading}
        testID="movie-form-submit-button"
        accessibilityLabel={mode === 'create' ? 'Add movie' : 'Save changes'}
        accessibilityState={{ disabled: isLoading }}
      />
    </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Built from the active theme so the form follows the dark/light DS palette.
// Layout is unchanged; only color roles are token-driven (FR-002 / FR-018).

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  formContainer: { flex: 1, backgroundColor: theme.background?.val },
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 8 },
  sectionHeader: {
    fontFamily: 'Outfit',
    fontSize: 16,
    fontWeight: '700',
    color: theme.onSurface?.val,
    marginTop: 24,
    marginBottom: 8,
    borderTopWidth: 1,
    borderTopColor: theme.outlineVariant?.val,
    paddingTop: 16,
  },
  label: {
    fontFamily: 'Inter',
    fontSize: 14,
    fontWeight: '600',
    color: theme.onSurfaceVariant?.val,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.outline?.val,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: 'Inter',
    color: theme.onSurface?.val,
    backgroundColor: theme.surfaceVariant?.val,
    marginBottom: 4,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  inputError: { borderColor: theme.error?.val },
  radioGroup: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 4,
  },
  radioButton: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.outline?.val,
    backgroundColor: theme.surfaceVariant?.val,
  },
  radioButtonSelected: {
    borderColor: theme.primary?.val,
    backgroundColor: theme.secondaryContainer?.val,
  },
  radioText: { color: theme.onSurfaceVariant?.val, fontFamily: 'Inter', fontSize: 14, fontWeight: '500' },
  radioTextSelected: { color: theme.primary?.val, fontFamily: 'Inter', fontWeight: '700' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
    marginTop: 4,
  },
  // chipText is the label for the removable list chips (directors/actors/genres/tags) — a
  // sanctioned deviation (no DS removable-chip variant yet). The multi-select owned-media /
  // rip-quality chips now use the DS Chip, so their bespoke styles were removed.
  chipText: { color: theme.onSurfaceVariant?.val, fontFamily: 'Inter', fontSize: 14 },
  chipWithRemove: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.outline?.val,
    backgroundColor: theme.surfaceVariant?.val,
    gap: 6,
  },
  removeText: { color: theme.error?.val, fontFamily: 'Inter', fontSize: 16, fontWeight: '700' },
  addRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  addInput: { flex: 1, marginBottom: 0 },
  externalIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: theme.surfaceVariant?.val,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.outline?.val,
    marginBottom: 4,
  },
  externalIdText: { color: theme.onSurfaceVariant?.val, fontFamily: 'Inter', fontSize: 14, flex: 1 },
  serverErrorBanner: {
    backgroundColor: theme.errorContainer?.val,
    borderColor: theme.error?.val,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  serverErrorText: { color: theme.onErrorContainer?.val, fontFamily: 'Inter', fontSize: 14 },
  errorText: { color: theme.error?.val, fontFamily: 'Inter', fontSize: 14, marginTop: 2 },
  helperText: { color: theme.onSurfaceVariant?.val, fontFamily: 'Inter', fontSize: 12, marginTop: 2 },
  actionsFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: theme.outlineVariant?.val,
    backgroundColor: theme.surface1?.val,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
});
