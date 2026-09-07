import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Trash, X, Sparkle, Shuffle } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";

const STORAGE_KEY = "open-wardrobe-edits-v1";
const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";
const USER_KEY = "open-wardrobe-user";

const TYPES = [
  { id: "all", label: "All" },
  { id: "upperbody", label: "Tops", singular: "Top" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket" },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const TYPE_ORDER = Object.fromEntries(TYPES.slice(1).map((type, index) => [type.id, index]));


function readEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}


function persistEdit(item) {
  const edits = readEdits();
  edits[item.id] = {
    name: item.name || "",
    part: item.part,
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    tags: item.tags || [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function removePersistedEdit(id) {
  const edits = readEdits();
  delete edits[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function readDeletedItems() {
  try {
    const value = JSON.parse(localStorage.getItem(DELETED_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistDeletedItem(id) {
  const deleted = readDeletedItems();
  deleted.add(id);
  localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify([...deleted]));
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

function AuthForm({ mode, onLogin, onRegister, onSwitch }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "login") await onLogin(username, password);
      else await onRegister(username, password, displayName);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {mode === "register" && (
        <input type="text" placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={inputStyle} />
      )}
      <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required style={inputStyle} />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required style={inputStyle} />
      {error && <p style={{ color: "var(--status-error)", fontSize: 13, margin: 0 }}>{error}</p>}
      <button type="submit" className="primary-button" disabled={loading} style={{ marginTop: 4 }}>
        {loading ? "..." : mode === "login" ? "Sign In" : "Create Account"}
      </button>
      <button type="button" onClick={onSwitch} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 12, cursor: "pointer" }}>
        {mode === "login" ? "No account? Register" : "Have an account? Sign In"}
      </button>
    </form>
  );
}

const inputStyle = { width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-secondary)", color: "var(--text)", fontSize: 14, boxSizing: "border-box" };

function GalleryItem({ item, selected, onOpen }) {
  const type = TYPE_MAP[item.part]?.singular || "wardrobe item";

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}`}
      type="button"
      onClick={() => onOpen(item.id)}
      aria-label={`View ${item.name || type}`}
      aria-pressed={selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <OptimizedImage
        src={item.thumbnail || item.image}
        alt=""
        sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 180px"
        breakpoints={[120, 180, 240, 320, 480]}
      />
    </button>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`Remove ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="Add a detail"
          aria-label="Add detail tag"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="Add detail">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>Optional</small>
        </div>
        <p>No distinct secondary color detected.</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>Add secondary color</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>Remove</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`Choose ${label.toLowerCase()}`}
        />
        <span className="selected-color-copy">
          <small>Selected</small>
          <strong>{value || "Custom"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>Image suggestions</span>
        <small>Click to apply</small>
      </div>
      <div className="palette" aria-label={`${label} suggestions from image`}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`Use ${color} as ${label.toLowerCase()}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "Cancel picking" : `Pick ${label.toLowerCase()} from image`}
      </button>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={TYPE_MAP[draft.part]?.singular || "Wardrobe item"}
        />
      </label>

      <label className="field">
        <span>Category</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <fieldset className="color-field">
        <legend>Colors</legend>
        <div className="colors-editor">
          <ColorControl
            label="Primary color"
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label="Secondary color"
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        <p className="color-help" aria-live="polite">{sampling ? `Click anywhere on the garment to sample the ${sampling} color.` : sampleStatus || "Primary colors come from the image. A secondary is suggested only when a distinct color has meaningful coverage."}</p>
      </fieldset>

      <div className="field details-field">
        <span>Details</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

function ItemViewer({ item, onClose, onSave, onDelete }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || "Wardrobe item";
  const hasModeledImage = Boolean(item.modeledImage);
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (sampling) setSampling(null);
        else requestClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, [requestClose, sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  }, [item]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = () => {
    onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
    setSampling(null);
    setSampleStatus("Changes saved.");
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus("That spot is transparent—try directly on the garment.");
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`Sampled ${color} as the ${sampling} color.`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-floating" : ""}${sampling ? " sampling" : ""}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        ref={imageRef}
        src={item.image}
        alt={`Selected ${type.toLowerCase()}`}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">Click garment to sample</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label="Selected wardrobe item">
      <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="Close viewer" ref={closeButtonRef}>
        <X size={24} weight="light" aria-hidden="true" />
      </button>

      {hasModeledImage ? (
        <div className="modeled-hero">
          <OptimizedImage
            className="modeled-hero-photo"
            src={item.modeledImage}
            alt={`${draft.name || type} worn by a model`}
            sizes="(max-width: 860px) 100vw, 520px"
            breakpoints={[320, 480, 640, 800, 1040, 1280]}
            quality={82}
            priority
          />
          <div className="viewer-heading modeled-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </div>
      ) : (
        <>
          <div className="viewer-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </>
      )}

      <div className="viewer-details editing">
        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        {closeBlocked && <p className="unsaved-notice" role="status">Save or cancel changes before closing.</p>}

        <div className="viewer-actions">
          <button className="delete-button" type="button" onClick={() => onDelete(item.id)}>
            <Trash size={15} weight="regular" aria-hidden="true" /> Delete
          </button>
          <span className="action-spacer" />
          <button className="secondary-button" type="button" onClick={cancelEditing}>Cancel</button>
          <button className="primary-button" type="button" onClick={saveEditing}>
            <Check size={15} weight="bold" aria-hidden="true" /> Save
          </button>
        </div>
      </div>
    </aside>
    </div>
    </div>
  );
}

function OutfitsPanel({ items, outfits, onCreate, onUpdate, onDelete, currentUser }) {
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [selectedGarments, setSelectedGarments] = useState(new Set());
  const [outfitName, setOutfitName] = useState("");
  const [outfitOccasion, setOutfitOccasion] = useState("casual");
  const garmentsById = useMemo(() => Object.fromEntries(items.map((g) => [g.id, g])), [items]);

  const [mode, setMode] = useState("smart");
  const [mood, setMood] = useState("casual");
  const [chosenColor, setChosenColor] = useState("#4f8cff");
  const [weather, setWeather] = useState(null);
  const [weatherState, setWeatherState] = useState("idle");

  const COLOR_CHOICES = ["#000000", "#4f8cff", "#e63946", "#2a9d3f", "#f4a261", "#7b2ff7", "#8d99ae", "#ffffff", "#795548"];

  const fetchWeather = useCallback(async () => {
    setWeatherState("locating");
    const coords = await new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(null),
        { timeout: 6000 }
      );
    });
    if (!coords) { setWeatherState("manual"); return; }
    try {
      setWeatherState("fetching");
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m`
      );
      const data = await res.json();
      const code = data.current?.weather_code;
      const condition = code === 0 || code === 1 ? "clear" : (code === 2 || code === 3) ? "cloudy" : (code >= 51 && code <= 67) ? "rain" : (code >= 71 && code <= 86) ? "snow" : "cloudy";
      setWeather({
        temp: Math.round(data.current?.temperature_2m || 15),
        condition,
        humidity: data.current?.relative_humidity_2m,
        wind: Math.round(data.current?.wind_speed_10m || 0),
      });
      setWeatherState("ready");
    } catch {
      setWeatherState("manual");
    }
  }, []);

  const seasonFromDate = () => {
    const m = new Date().getMonth();
    return (m >= 11 || m <= 1) ? "winter" : (m <= 4) ? "spring" : (m <= 7) ? "summer" : "autumn";
  };

  const CONDITION_LABEL = { clear: "Despejado", cloudy: "Nublado", rain: "Lluvia", snow: "Nieve" };

  const handleSuggest = async () => {
    setLoadingSuggestions(true);
    try {
      const q = new URLSearchParams({ mode, season: seasonFromDate() });
      if (mode === "mood") q.set("mood", mood);
      if (mode === "color") q.set("color", chosenColor);
      if (mode === "weather") {
        if (!weather) await fetchWeather();
        if (weather) {
          q.set("condition", weather.condition);
          q.set("temp", String(weather.temp));
        }
      }
      const headers = {};
      if (currentUser) headers["x-user-id"] = currentUser.userId;
      const res = await fetch(`/api/outfits/suggest?${q}`, { headers });
      const data = await res.json();
      setSuggestions(data.outfits || []);
      setSuggestIndex(0);
    } finally { setLoadingSuggestions(false); }
  };

  const rateSuggestion = async (s, liked) => {
    if (liked) {
      const created = await onCreate({ name: s.name, occasion: s.occasion, garmentIds: s.garmentIds });
      if (created?.id) {
        const headers = {};
        if (currentUser) headers["x-user-id"] = currentUser.userId;
        await fetch("/api/outfits/feedback", {
          method: "POST",
          headers,
          body: JSON.stringify({
            outfitId: created.id,
            liked: true,
            occasion: s.occasion || null,
            season: Array.isArray(s.season) ? (s.season[0] || null) : null,
          }),
        }).catch(() => {});
      }
    }
    setSuggestions((cur) => cur.filter((x) => x !== s));
  };

  const renderCollage = (garmentIds) => {
    const set = garmentIds.map((id) => garmentsById[id]).filter(Boolean);
    const outer = set.find((g) => g.part === "wholebody_up");
    const tops = set.filter((g) => g.part === "upperbody");
    const bottoms = set.filter((g) => g.part === "lowerbody");
    const shoes = set.filter((g) => g.part === "shoes");
    const accs = set.filter((g) => g.part === "accessories_up");

    const img = (g, w) => g && (
      <div className="canvas-piece">
        <OptimizedImage src={g.image} alt={g.name} sizes={`${w}px`} breakpoints={[Math.round(w * 0.5), w, Math.round(w * 1.4)]} />
      </div>
    );

    if (!set.length) {
      return <div className="canvas-stage"><div className="canvas-empty">Sin prendas</div></div>;
    }

    return (
      <div className={`canvas-stage${(shoes.length > 0 || accs.length > 0) ? " has-accents" : ""}`}>
        {outer && <div className="canvas-outer">{img(outer, 158)}</div>}
        <div className="canvas-middle">
          {tops.slice(0, 1).map((t) => (
            <div key={t.id} className="canvas-slot canvas-top">{img(t, 128)}</div>
          ))}
          {bottoms.slice(0, 1).map((b) => (
            <div key={b.id} className="canvas-slot canvas-bottom">{img(b, 116)}</div>
          ))}
          {!tops.length && !bottoms.length && outer && (
            <div className="canvas-slot canvas-top">{img(outer, 142)}</div>
          )}
        </div>
        {(shoes.length > 0 || accs.length > 0) && (
          <div className="canvas-accents">
            {shoes.slice(0, 1).map((s) => (
              <div key={s.id} className="canvas-slot canvas-shoes">{img(s, 66)}</div>
            ))}
            {accs.slice(0, 3).map((a) => (
              <div key={a.id} className="canvas-slot canvas-acc">{img(a, 42)}</div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const openBuilder = (id) => {
    if (id) {
      const o = outfits.find((x) => x.id === id);
      if (o) {
        setOutfitName(o.name); setOutfitOccasion(o.occasion || "casual");
        setSelectedGarments(new Set(o.garmentIds || []));
      }
    } else {
      setOutfitName(""); setOutfitOccasion("casual"); setSelectedGarments(new Set());
    }
    setEditingId(id);
    setBuilderOpen(true);
  };

  const handleSaveOutfit = async () => {
    const payload = { name: outfitName || `Conjunto ${outfits.length + 1}`, occasion: outfitOccasion, garmentIds: [...selectedGarments] };
    if (editingId) await onUpdate(editingId, payload);
    else await onCreate(payload);
    setBuilderOpen(false);
  };

  return (
    <section className="outfits-panel">
      <header className="outfits-header">
        <h2>Outfits</h2>
        <div className="outfits-actions">
          <button className="secondary-button" onClick={handleSuggest} disabled={loadingSuggestions}>
            <Sparkle size={14} weight="bold" /> {loadingSuggestions ? "..." : "Generar"}
          </button>
          <button className="primary-button" onClick={() => openBuilder(null)}>
            <Plus size={14} weight="bold" /> New
          </button>
        </div>
      </header>

      <section className="suggest-controls">
        <div className="suggest-modes">
          {[
            { id: "smart", label: "Smart" },
            { id: "random", label: "Random" },
            { id: "mood", label: "Mood" },
            { id: "color", label: "Color" },
            { id: "weather", label: "Tiempo hoy" },
          ].map((m) => (
            <button key={m.id} type="button" className={`suggest-mode ${mode === m.id ? "active" : ""}`} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>

        <div className="suggest-options">
          {mode === "mood" && (
            <select value={mood} onChange={(e) => setMood(e.target.value)} className="suggest-select">
              <option value="casual">Casual</option>
              <option value="smart">Arreglado</option>
              <option value="formal">Formal</option>
              <option value="sport">Deporte</option>
            </select>
          )}
          {mode === "color" && (
            <div className="color-choices">
              {COLOR_CHOICES.map((c) => (
                <button key={c} type="button" className={`color-dot ${chosenColor === c ? "active" : ""}`} style={{ background: c }} onClick={() => setChosenColor(c)} aria-label={`Color ${c}`} />
              ))}
              <input type="color" value={chosenColor} onChange={(e) => setChosenColor(e.target.value)} className="color-picker" />
            </div>
          )}
          {mode === "weather" && (
            <div className="weather-box">
              {weatherState === "locating" || weatherState === "fetching" ? <span>Localizando...</span> :
                weather ? <>
                  <span className={`weather-icon weather-${weather.condition}`}>{"☀️🌥️🌧️🌨️"["clear cloudy rain snow".split(" ").indexOf(weather.condition)] || "🌡️"}</span>
                  <span><strong>{weather.temp}°C</strong> {CONDITION_LABEL[weather.condition]}</span>
                  {weather.wind > 10 && <span className="weather-wind">🍃 {weather.wind} km/h</span>}
                </> : <button className="secondary-button" onClick={fetchWeather}>Usar mi ubicación</button>}
            </div>
          )}
        </div>
      </section>

      {suggestions.length > 0 && (
        <section className="outfit-suggestions">
          <h3>Sugerencias · {suggestIndex + 1} / {suggestions.length}</h3>
          {(() => {
            const s = suggestions[suggestIndex];
            if (!s) {
              return (
                <div className="tinder-empty">
                  <p>No quedan looks por valorar.</p>
                  <button className="primary-button" onClick={handleSuggest}>
                    <Shuffle size={14} weight="bold" /> Generar otros
                  </button>
                </div>
              );
            }
            return (
              <div className="tinder-card">
                <div className="tinder-visual">{renderCollage(s.garmentIds)}</div>
                <div className="tinder-meta">
                  <h4>{s.name}</h4>
                  <small>{s.occasion}</small>
                </div>
                <div className="tinder-actions">
                  <button className="tinder-skip" onClick={() => setSuggestIndex((i) => i + 1)} aria-label="Pasar" title="Pasar">
                    <Shuffle size={18} weight="bold" />
                  </button>
                  <button className="tinder-dislike" onClick={() => rateSuggestion(s, false)} aria-label="No me gusta" title="No me gusta">
                    <X size={22} weight="bold" />
                  </button>
                  <button className="tinder-like" onClick={() => rateSuggestion(s, true)} aria-label="Me gusta" title="Me gusta">
                    <Check size={22} weight="bold" />
                  </button>
                </div>
              </div>
            );
          })()}
        </section>
      )}

      {outfits.length === 0 && !loadingSuggestions ? (
        <p className="status empty">No outfits yet. Compose your first look.</p>
      ) : (
        <div className="outfits-grid">
          {outfits.map((o) => (
            <article key={o.id} className="outfit-card">
              {renderCollage(o.garmentIds || [])}
              <div className="outfit-card-body">
                <h4>{o.name}</h4>
                {o.occasion && <small>{o.occasion}</small>}
                <div className="outfit-card-actions">
                  <button className="secondary-button" onClick={() => openBuilder(o.id)}>Edit</button>
                  <button className="delete-button" onClick={() => onDelete(o.id)}><Trash size={12} weight="regular" /></button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {builderOpen && (
        <div className="outfit-builder-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setBuilderOpen(false)}>
          <div className="outfit-builder" role="dialog" aria-modal="true">
            <header className="outfit-builder-header">
              <h3>{editingId ? "Edit outfit" : "New outfit"}</h3>
              <button className="icon-button" onClick={() => setBuilderOpen(false)}><X size={20} weight="light" /></button>
            </header>

            <div className="outfit-builder-preview">{renderCollage([...selectedGarments])}</div>

            <div className="outfit-builder-fields">
              <label className="field">
                <span>Name</span>
                <input value={outfitName} onChange={(e) => setOutfitName(e.target.value)} placeholder="My Monday look" />
              </label>
              <label className="field">
                <span>Occasion</span>
                <select value={outfitOccasion} onChange={(e) => setOutfitOccasion(e.target.value)}>
                  <option value="casual">Casual</option>
                  <option value="formal">Formal</option>
                  <option value="sport">Sport</option>
                  <option value="neutral">Everyday</option>
                </select>
              </label>
            </div>

            <div className="outfit-picker">
              <p className="outfit-picker-label">Pick pieces</p>
              <div className="outfit-picker-grid">
                {items.map((g) => (
                  <button key={g.id} type="button"
                    className={`picker-item ${selectedGarments.has(g.id) ? "selected" : ""}`}
                    onClick={() => setSelectedGarments((cur) => { const n = new Set(cur); n.has(g.id) ? n.delete(g.id) : n.add(g.id); return n; })}
                    aria-pressed={selectedGarments.has(g.id)}>
                    <OptimizedImage src={g.thumbnail || g.image} alt="" sizes="70px" breakpoints={[50, 70, 100]} />
                    <small>{g.name}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="outfit-builder-actions">
              <button className="secondary-button" onClick={() => {
                const tops = items.filter((g) => g.part === "upperbody" || g.part === "wholebody_up");
                const bottoms = items.filter((g) => g.part === "lowerbody");
                const shoes = items.filter((g) => g.part === "shoes");
                const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
                const s = new Set();
                if (pick(tops)) s.add(pick(tops).id);
                if (pick(bottoms)) s.add(pick(bottoms).id);
                if (pick(shoes)) s.add(pick(shoes).id);
                setSelectedGarments(s);
                setOutfitName(`Random ${outfits.length + 1}`);
              }}>
                <Shuffle size={14} weight="bold" /> Random
              </button>
              <button className="primary-button" onClick={handleSaveOutfit} disabled={!selectedGarments.size}>
                <Check size={14} weight="bold" /> {editingId ? "Update" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function App() {
  const [items, setItems] = useState([]);
  const [outfits, setOutfits] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("closet");
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
  });
  const [authMode, setAuthMode] = useState("login");
  const [showAuth, setShowAuth] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (currentUser) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/guest", { credentials: "include" });
        if (!active || !res.ok) return;
        const data = await res.json();
        if (data?.userId) {
          const user = { userId: data.userId, username: data.username, displayName: data.displayName };
          setCurrentUser(user);
          localStorage.setItem(USER_KEY, JSON.stringify(user));
        }
      } catch {}
    })();
    return () => { active = false; };
  }, [currentUser]);

  const authHeaders = useCallback(() => {
    const headers = { "Content-Type": "application/json" };
    if (currentUser) headers["x-user-id"] = currentUser.userId;
    return headers;
  }, [currentUser]);

  const login = useCallback(async (username, password) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    const user = { userId: data.userId, username: data.username, displayName: data.displayName };
    setCurrentUser(user);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    setShowAuth(false);
    reload();
  }, []);

  const register = useCallback(async (username, password, displayName) => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, displayName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Register failed");
    const user = { userId: data.userId, username: data.username, displayName: data.displayName };
    setCurrentUser(user);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    setShowAuth(false);
    reload();
  }, []);

  const logout = useCallback(() => {
    setCurrentUser(null);
    localStorage.removeItem(USER_KEY);
    setItems([]);
    setOutfits([]);
  }, []);

  const reload = useCallback(async () => {
    try {
      const headers = authHeaders();
      const [gRes, oRes] = await Promise.all([
        fetch("/api/garments", { ...headers, cache: "no-store" }),
        fetch("/api/outfits", { ...headers, cache: "no-store" }),
      ]);
      const loadedItems = gRes.ok ? await gRes.json() : [];
      const loadedOutfits = oRes.ok ? await oRes.json() : [];
      const edits = readEdits();
      const deleted = readDeletedItems();
      const visibleItems = loadedItems.filter((item) => !deleted.has(item.id));
      setItems(visibleItems.map((item) => ({ ...item, ...(edits[item.id] || {}) })));
      setOutfits(loadedOutfits);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => { reload(); }, [currentUser]);

  const handleImport = useCallback(async (files) => {
    const images = [...files].filter(f => f.type.startsWith("image/"));
    if (!images.length) return;
    setImporting(true); setError(""); setDragging(false);
    for (const file of images) {
      try {
        const reader = new FileReader();
        const dataUrl = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Could not read file"));
          reader.readAsDataURL(file);
        });
        const base64 = dataUrl.split(",")[1];
        const res = await fetch("/api/garments/import", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ imageBase64: base64, mimeType: file.type }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Import failed");
        }
        const newItem = await res.json();
        setItems(current => [newItem, ...current]);
      } catch (e) {
        setError(`Import failed: ${e.message}`);
      }
    }
    setImporting(false);
  }, []);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (e) => { if (![...e.dataTransfer.types].includes("Files")) return; e.preventDefault(); depth++; setDragging(true); };
    const onDragOver = (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); };
    const onDragLeave = (e) => { e.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onDrop = (e) => { e.preventDefault(); depth = 0; setDragging(false); handleImport(e.dataTransfer.files); };
    const onPaste = (e) => { const files = [...e.clipboardData.files]; if (files.some(f => f.type.startsWith("image/"))) { e.preventDefault(); handleImport(files); } };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [handleImport]);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const visibleItems = useMemo(() => {
    const filtered = activeType === "all" ? items : items.filter((item) => item.part === activeType);
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
  };

  const saveItem = (updatedItem) => {
    setItems((current) => current.map((item) => item.id === updatedItem.id ? updatedItem : item));
    persistEdit(updatedItem);
    fetch(`/api/garments/${updatedItem.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(updatedItem),
    }).catch(() => {});
  };

  const deleteItem = async (id) => {
    if (id.startsWith("import-")) {
      try {
        const response = await fetch(`/api/garments/${id}`, { method: "DELETE", headers: authHeaders() });
        if (!response.ok && response.status !== 404) throw new Error("Could not delete the imported item.");
      } catch (requestError) {
        setError(requestError.message);
        return;
      }
    }
    setItems((current) => current.filter((item) => item.id !== id));
    removePersistedEdit(id);
    persistDeletedItem(id);
    setSelectedId(null);
  };

  const createOutfit = async (payload) => {
    const res = await fetch("/api/outfits", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) { setError("Could not save outfit"); return null; }
    const created = await res.json();
    setOutfits((cur) => [created, ...cur]);
    return created;
  };

  const updateOutfit = async (id, payload) => {
    const res = await fetch(`/api/outfits/${id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) { setError("Could not update outfit"); return; }
    const updated = await res.json();
    setOutfits((cur) => cur.map((o) => o.id === id ? updated : o));
  };

  const deleteOutfit = async (id) => {
    await fetch(`/api/outfits/${id}`, { method: "DELETE", headers: authHeaders() });
    setOutfits((cur) => cur.filter((o) => o.id !== id));
  };

  return (
    <div className={`app-shell${selectedItem ? " has-selection" : ""}${dragging ? " is-dragging" : ""}`}>
      {showAuth && (
        <div className="import-drop-overlay" onClick={() => setShowAuth(false)}>
          <div className="import-drop-target" style={{ maxWidth: 360, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 16 }}>{authMode === "login" ? "Sign In" : "Create Account"}</h2>
            <AuthForm
              mode={authMode}
              onLogin={login}
              onRegister={register}
              onSwitch={() => setAuthMode(authMode === "login" ? "register" : "login")}
            />
          </div>
        </div>
      )}
      <header className="app-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontWeight: 600 }}>Wardrobe</span>
        {currentUser ? (
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{currentUser.displayName}</span>
            <button className="primary-button" style={{ fontSize: 12, padding: "4px 12px" }} onClick={logout}>Logout</button>
          </div>
        ) : (
          <button className="primary-button" style={{ fontSize: 12, padding: "4px 12px" }} onClick={() => { setAuthMode("login"); setShowAuth(true); }}>Sign In</button>
        )}
      </header>
      <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { handleImport(e.target.files); e.target.value = ""; }} />
      {dragging && (
        <div className="import-drop-overlay">
          <div className="import-drop-target">
            <Plus size={34} weight="light" />
            <h2>Drop clothing images</h2>
            <p>Gemini will analyze each piece automatically</p>
          </div>
        </div>
      )}

      <nav className="tab-bar">
        <button type="button" className={activeTab === "closet" ? "active" : ""} onClick={() => setActiveTab("closet")}>
          Closet
        </button>
        <button type="button" className={activeTab === "outfits" ? "active" : ""} onClick={() => setActiveTab("outfits")}>
          Outfits
        </button>
      </nav>

      {activeTab === "closet" && (
      <main className="gallery-pane">
        <header className="gallery-header">
          <div className="gallery-meta-row">
            <p className="piece-count">{items.length} {items.length === 1 ? "piece" : "pieces"}</p>
            <button className="primary-button import-button-header" onClick={() => fileInputRef.current?.click()} disabled={importing}>
              <Plus size={14} weight="bold" /> {importing ? "Analyzing..." : "Import"}
            </button>
          </div>
          <nav className="category-nav" aria-label="Filter wardrobe by item type">
            {TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={activeType === type.id ? "active" : ""}
                onClick={() => chooseType(type.id)}
                aria-pressed={activeType === type.id}
              >
                {type.label}
              </button>
            ))}
          </nav>
        </header>

        {error && <p className="status error">{error}</p>}
        {!error && loading && <p className="status">Loading wardrobe</p>}
        {!error && !loading && !items.length && <p className="status empty">Drop, paste, or add a photo to import your first piece.</p>}

        {!!items.length && (
          <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}>
            {visibleItems.map((item) => (
              <GalleryItem
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onOpen={setSelectedId}
              />
            ))}
          </section>
        )}
      </main>
      )}

      {activeTab === "outfits" && (
        <OutfitsPanel
          items={items}
          outfits={outfits}
          currentUser={currentUser}
          onCreate={createOutfit}
          onUpdate={updateOutfit}
          onDelete={deleteOutfit}
          onLoadSuggestions={reload}
        />
      )}

      {selectedItem && <ItemViewer item={selectedItem} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} />}
    </div>
  );
}
