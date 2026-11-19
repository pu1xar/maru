// Local file (not from T3 Code; T3's MermaidDiagram.tsx is the model, same Pele renderer, same
// sanitizer idea). This module is the only importer of pele and dompurify, and a Mermaid block
// loads it through React.lazy, so those packages sit in their own chunks that the page fetches
// when the first diagram appears (DESIGN.md 7g).
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { mermaidMinWidth } from "./MarkdownMermaid.logic";

type Pele = typeof import("pele/lazy");
type Purifier = ReturnType<(typeof import("dompurify"))["default"]>;
interface Engine {
  readonly pele: Pele;
  readonly purify: Purifier;
}

let core: Promise<Engine> | null = null;
let coreReady: Engine | null = null;
// Each diagram type is its own chunk, so a chat with one flowchart loads only the flowchart parser
// and layout.
const typeLoads = new Map<string, Promise<unknown>>();
const typesReady = new Set<string>();

function loadCore(): Promise<Engine> {
  core ??= Promise.all([import("pele/lazy"), import("dompurify")]).then(
    ([pele, purifier]) => (coreReady = { pele, purify: purifier.default(window) }),
    (cause: unknown) => {
      core = null;
      throw cause;
    },
  );
  return core;
}

async function loadEngine(source: string): Promise<Engine> {
  const engine = await loadCore();
  const type = engine.pele.detectType(source);
  if (type) {
    let load = typeLoads.get(type);
    if (!load) {
      load = engine.pele.load(type).then(() => typesReady.add(type));
      typeLoads.set(type, load);
      load.catch(() => typeLoads.delete(type));
    }
    await load;
  }
  return engine;
}

/**
 * The engine when the core and this source's diagram type are already loaded, else null. A diagram
 * that mounts again (a streamed answer finishing re-keys its blocks) then draws in the same commit
 * instead of showing the placeholder for a frame.
 */
function readyEngine(source: string): Engine | null {
  if (!coreReady) return null;
  const type = coreReady.pele.detectType(source);
  return type === null || typesReady.has(type) ? coreReady : null;
}

/**
 * The drawn SVG goes through DOMPurify before it is attached: no links, images, foreign objects,
 * style elements or href-like attributes survive, whatever the diagram text said. Pele already
 * escapes labels and has links and images off here, so this is the second layer.
 */
function sanitizeSvg(purify: Purifier) {
  return (svg: string): Node =>
    purify.sanitize(svg, {
      FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
      FORBID_TAGS: ["a", "image", "img", "foreignObject", "script", "style"],
      USE_PROFILES: { svg: true, svgFilters: true },
      RETURN_DOM_FRAGMENT: true,
    });
}

// Pele colors a diagram through these. A standalone image cannot inherit them from the page.
const PELE_VARIABLES = [
  "--pele-bg",
  "--pele-fg",
  "--pele-muted",
  "--pele-line",
  "--pele-surface",
  "--pele-surface-alt",
  "--pele-border",
  "--pele-accent",
  "--pele-critical",
  "--pele-font",
  "--pele-radius",
  ...Array.from({ length: 8 }, (_, index) => `--pele-series-${index + 1}`),
];

/** The drawn diagram as a standalone SVG blob URL with the page's colors written into it. */
export function diagramImageUrl(svg: SVGSVGElement): string {
  const element = svg.cloneNode(true) as SVGSVGElement;
  const computed = getComputedStyle(svg);
  for (const name of PELE_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) element.style.setProperty(name, value);
  }
  element.style.maxWidth = "none";
  element.style.minWidth = "0";
  element.style.backgroundColor = getComputedStyle(document.body).backgroundColor;
  return URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(element)], { type: "image/svg+xml" }),
  );
}

export default function MermaidDiagram({
  source,
  onFailed,
  onExpand,
}: {
  source: string;
  onFailed: (error: unknown) => void;
  onExpand: (svg: SVGSVGElement) => void;
}) {
  // The engine is paired with the source whose diagram type it loaded; a changed source waits for
  // its own load instead of drawing with the previous source's types.
  const [loaded, setLoaded] = useState<{ source: string; engine: Engine } | null>(null);
  const engine = loaded?.source === source ? loaded.engine : readyEngine(source);
  const container = useRef<HTMLSpanElement>(null);
  // Held in a ref so a new callback identity does not draw the diagram again.
  const failed = useRef(onFailed);
  failed.current = onFailed;

  useEffect(() => {
    let current = true;
    loadEngine(source).then(
      (engine) => {
        if (current) setLoaded({ source, engine });
      },
      (cause: unknown) => {
        if (current) failed.current(cause);
      },
    );
    return () => {
      current = false;
    };
  }, [source]);

  // Before paint, so a diagram that is ready never shows an empty frame.
  useLayoutEffect(() => {
    const element = container.current;
    if (!engine || !element) return;
    let mounted: ReturnType<Pele["mount"]> | null = null;
    try {
      mounted = engine.pele.mount(element, source, {
        links: false,
        images: false,
        zoom: false,
        // The author's direction stays; a wide diagram narrows (down to a floor) and then scrolls.
        autoDirection: false,
        sanitize: sanitizeSvg(engine.purify),
        onRender: (result) => {
          const svg = element.querySelector("svg");
          if (svg) svg.style.minWidth = `${mermaidMinWidth(result.width)}px`;
        },
        onError: (cause) => failed.current(cause),
      });
    } catch (cause) {
      failed.current(cause);
    }
    return () => mounted?.destroy();
  }, [engine, source]);

  return (
    <button
      type="button"
      aria-label="Expand diagram"
      className="block w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => {
        const svg = container.current?.querySelector("svg");
        if (svg) onExpand(svg);
      }}
    >
      {engine ? null : (
        <span
          data-thread-find-ignore
          className="flex h-12 items-center justify-center text-xs text-muted-foreground"
        >
          Drawing diagram
        </span>
      )}
      <span ref={container} className="flex w-full [justify-content:safe_center]" />
    </button>
  );
}
