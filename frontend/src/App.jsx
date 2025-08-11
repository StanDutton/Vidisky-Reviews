import React, { useMemo, useRef, useState } from "react";

// --- simple keyword rules ---
const KEYWORDS = {
  security: [
    "trespass","trespasser","loiter","loitering","theft","stolen","break-in","break in","broken into",
    "burglary","vandal","vandalism","homeless","transient","drug","crime","criminal","suspicious",
    "car break","catalytic","porch pirate","police","weapon","gun","knife","fight","assault"
  ],
  pet: [
    "dog poop","poop","pet waste","dog waste","didn't pick up","did not pick up","feces","droppings","poo",
    "mess from dogs","dogs everywhere"
  ],
  amenity: [
    "amenity misuse","pool party","after hours","after-hours","noise","loud","non-residents","guests using",
    "gym crowd","smoking by pool","smoke at pool","parking unauthorized","illegal parking","trash dumping",
    "dumpster","package theft","mailroom"
  ],
  safety: [
    "unsafe","not safe","sketchy","poor lighting","dark at night","gate broken","gate stuck open","door propped",
    "fire alarm","elevator stuck","assault","harassed","threatening"
  ]
};

function tokenize(text) {
  return (text || "")
    .replace(/\n+/g, "\n")
    .split(/\n|\.|!|\?|\\r/g)
    .map((s) => s.trim())
    .filter(Boolean);
}
function classifySentence(sentence) {
  const s = sentence.toLowerCase();
  const hit = { security: false, pet: false, amenity: false, safety: false };
  Object.entries(KEYWORDS).forEach(([k, arr]) =>
    arr.forEach((w) => {
      if (s.includes(w)) hit[k] = true;
    })
  );
  return hit;
}
function aggregateInsights(items) {
  const buckets = { security: [], pet: [], amenity: [], safety: [] };
  items.forEach((item) => {
    tokenize(item.text).forEach((sentence) => {
      const label = classifySentence(sentence);
      const row = { sentence, source: item.source || "", url: item.url || "" };
      if (label.security) buckets.security.push(row);
      if (label.pet) buckets.pet.push(row);
      if (label.amenity) buckets.amenity.push(row);
      if (label.safety) buckets.safety.push(row);
    });
  });
  return buckets;
}
function scoreBadge(n) {
  if (n >= 6) return ["Severe", "#fee2e2", "#b91c1c"];
  if (n >= 3) return ["Moderate", "#ffedd5", "#c2410c"];
  if (n >= 1) return ["Noted", "#dcfce7", "#065f46"];
  return ["No signal", "#f1f5f9", "#334155"];
}

export default function App() {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [proxyBase, setProxyBase] = useState(""); // e.g., https://vidisky-proxy.onrender.com
  const [useGoogle, setUseGoogle] = useState(true);
  const [useACom, setUseACom] = useState(true);
  const [useAR, setUseAR] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const [mode, setMode] = useState("idle");
  const reportRef = useRef(null);

  const buckets = useMemo(() => aggregateInsights(items), [items]);
  const counts = {
    security: buckets.security.length,
    pet: buckets.pet.length,
    amenity: buckets.amenity.length,
    safety: buckets.safety.length,
  };
  const headline = useMemo(() => {
    const s =
      counts.security + counts.pet + counts.amenity + counts.safety;
    if (!s) return "No issues detected in the fetched reviews.";
    const parts = [];
    if (counts.security) parts.push(`${counts.security} security`);
    if (counts.pet) parts.push(`${counts.pet} pet-waste`);
    if (counts.amenity) parts.push(`${counts.amenity} amenity-misuse`);
    if (counts.safety) parts.push(`${counts.safety} safety`);
    return `Signals found: ${parts.join(", ")}.`;
  }, [counts]);

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const it of list) {
      const k = (it.text || "").toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
    return out;
  }
  async function fetchFrom(path) {
    const base = proxyBase.replace(/\/$/, "");
    const url = `${base}${path}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${path} failed`);
    return (await r.json()) || [];
  }
  async function runFetch() {
    setError("");
    setLoading(true);
    setMode("idle");
    try {
      if (!name || !location)
        throw new Error("Please enter name and location.");
      if (!proxyBase)
        throw new Error(
          "Please set your proxy base URL (e.g., https://your-proxy.onrender.com)."
        );
      const q = `?name=${encodeURIComponent(name)}&location=${encodeURIComponent(
        location
      )}`;
      const tasks = [];
      if (useGoogle) tasks.push(fetchFrom(`/google-reviews${q}`));
      if (useACom) tasks.push(fetchFrom(`/apartments-com${q}`));
      if (useAR) tasks.push(fetchFrom(`/apartmentratings${q}`));
      let results = (await Promise.allSettled(tasks)).flatMap((r) =>
        r.status === "fulfilled" ? r.value : []
      );
      setItems(dedupe(results).slice(0, 300));
      setMode("summarized");
    } catch (e) {
      setError(e.message || "Fetch failed");
    } finally {
      setLoading(false);
    }
  }

  async function exportPdf() {
    const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
      import("jspdf"),
      import("html2canvas"),
    ]);
    if (!reportRef.current) return;
    const node = reportRef.current;
    const canvas = await html2canvas(node, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
    });
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({ orientation: "p", unit: "pt", format: "a4" });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const iw = pw - 40;
    const ih = canvas.height * (iw / canvas.width);
    if (ih < ph - 40) {
      pdf.addImage(imgData, "PNG", 20, 20, iw, ih);
    } else {
      let left = ih,
        pos = 20;
      pdf.addImage(imgData, "PNG", 20, pos, iw, ih);
      left -= ph - 40;
      while (left > 0) {
        pdf.addPage();
        pos = 20 - (ih - left);
        pdf.addImage(imgData, "PNG", 20, pos, iw, ih);
        left -= ph - 40;
      }
    }
    const fname = `${(name || "Property")
      .replace(/\W+/g, "-")}-${(location || "Location")
      .replace(/\W+/g, "-")}-VIDISKY-Review-Summary.pdf`;
    pdf.save(fname);
  }

  const emailSummary = useMemo(
    () => buildEmailSummary({ name, location, counts, buckets }),
    [name, location, counts, buckets]
  );
  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(emailSummary);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = emailSummary;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  // minimal styles
  const box = {
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: 16,
    background: "white",
  };
  const label = { fontSize: 12, color: "#475569" };

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#0f172a" }}>
      <div
        style={{
          position: "sticky",
          top: 0,
          backdropFilter: "blur(6px)",
          background: "rgba(255,255,255,.7)",
          borderBottom: "1px solid #e2e8f0",
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "12px 16px",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <div style={{ fontWeight: 600 }}>VIDISKY Review Summarizer</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                setName("30 West Apartments");
                setLocation("Bradenton, FL");
              }}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: "6px 10px",
              }}
            >
              Prefill Demo
            </button>
            <button
              onClick={exportPdf}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: "6px 10px",
              }}
            >
              Export PDF
            </button>
          </div>
        </div>
      </div>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: 16 }}>
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 320px",
            gap: 16,
          }}
        >
          <div style={box}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              Find Reviews Automatically
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={label}>Apartment name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="(e.g., 30 West Apartments)"
                  style={{
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    padding: "8px",
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={label}>Location (City, ST)</span>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="(e.g., Bradenton, FL)"
                  style={{
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    padding: "8px",
                  }}
                />
              </label>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr",
                gap: 8,
                marginTop: 8,
              }}
            >
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={label}>Proxy Base URL</span>
                <input
                  value={proxyBase}
                  onChange={(e) => setProxyBase(e.target.value)}
                  placeholder="https://vidisky-proxy.onrender.com"
                  style={{
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    padding: "8px",
                  }}
                />
              </label>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 8,
                marginTop: 8,
              }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={useGoogle}
                  onChange={(e) => setUseGoogle(e.target.checked)}
                />{" "}
                Google
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={useACom}
                  onChange={(e) => setUseACom(e.target.checked)}
                />{" "}
                Apartments.com
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={useAR}
                  onChange={(e) => setUseAR(e.target.checked)}
                />{" "}
                ApartmentRatings
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                onClick={runFetch}
                disabled={loading}
                style={{
                  background: "black",
                  color: "white",
                  borderRadius: 10,
                  padding: "8px 12px",
                }}
              >
                {loading ? "Fetching…" : "Fetch & Summarize"}
              </button>
              <button
                onClick={copyEmail}
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: 10,
                  padding: "8px 12px",
                }}
              >
                Copy Email
              </button>
            </div>
            {error && (
              <div
                style={{
                  marginTop: 8,
                  color: "#b91c1c",
                  background: "#fee2e2",
                  border: "1px solid #fecaca",
                  padding: 8,
                  borderRadius: 8,
                }}
              >
                {error}
              </div>
            )}
          </div>

          <div style={box}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              Your Target Signals
            </div>
            {["Security", "Pet Waste", "Amenity Misuse", "Safety"].map(
              (label, i) => {
                const val = [
                  counts.security,
                  counts.pet,
                  counts.amenity,
                  counts.safety,
                ][i];
                const [txt, bg, fg] = scoreBadge(val);
                return (
                  <div
                    key={label}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontSize: 12, color: "#64748b" }}>{label}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontSize: 22, fontWeight: 600 }}>{val}</div>
                      <span
                        style={{
                          fontSize: 12,
                          border: "1px solid #e2e8f0",
                          borderRadius: 999,
                          padding: "2px 8px",
                          background: bg,
                          color: fg,
                        }}
                      >
                        {txt}
                      </span>
                    </div>
                  </div>
                );
              }
            )}
            <div style={{ fontSize: 13, color: "#475569", marginTop: 4 }}>
              {headline}
            </div>
          </div>
        </section>

        {mode === "summarized" && (
          <section
            ref={reportRef}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 320px",
              gap: 16,
              marginTop: 16,
            }}
          >
            <div style={box}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>
                Findings for {name || "(name)"}{location ? `, ${location}` : ""}
              </div>
              {[
                ["security", "Security Issues"],
                ["pet", "Pet Waste"],
                ["amenity", "Amenity Misuse"],
                ["safety", "Safety Concerns"],
              ].map(([key, title]) => {
                const n = counts[key];
                const [txt, bg, fg] = scoreBadge(n);
                const quotes = (buckets[key] || []).slice(0, 8);
                return (
                  <div
                    key={key}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 12,
                      padding: 12,
                      marginTop: 10,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{title}</div>
                      <span
                        style={{
                          fontSize: 12,
                          border: "1px solid #e2e8f0",
                          borderRadius: 999,
                          padding: "2px 8px",
                          background: bg,
                          color: fg,
                        }}
                      >
                        {txt}
                      </span>
                    </div>
                    {quotes.length ? (
                      <ul style={{ margin: "8px 0 0 18px" }}>
                        {quotes.map((q, i) => (
                          <li
                            key={i}
                            style={{ marginBottom: 6, fontSize: 14, lineHeight: "20px" }}
                          >
                            “{q.sentence}”
                            {q.url && (
                              <a
                                href={q.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  color: "#64748b",
                                  textDecoration: "underline",
                                  marginLeft: 6,
                                }}
                              >
                                source
                              </a>
                            )}
                            <span style={{ color: "#94a3b8", fontSize: 12 }}>
                              {" "}
                              [{q.source}]
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
                        No explicit mentions detected.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={box}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>
                Copy-to-Email Summary
              </div>
              <textarea
                rows={18}
                readOnly
                value={buildEmailSummary({ name, location, counts, buckets })}
                style={{
                  width: "100%",
                  border: "1px solid #cbd5e1",
                  borderRadius: 8,
                  padding: 8,
                  fontSize: 13,
                }}
              />
              <button
                onClick={copyEmail}
                style={{
                  marginTop: 8,
                  border: "1px solid #e2e8f0",
                  borderRadius: 10,
                  padding: "8px 12px",
                }}
              >
                Copy to Clipboard
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function buildEmailSummary({ name, location, counts, buckets }) {
  const nl = (n) => String(n || 0);
  const lines = [];
  lines.push(
    `Subject: Quick security takeaways – ${name || "Property"} (${
      location || "City, ST"
    })`
  );
  lines.push("");
  lines.push("Hi [Name] —");
  lines.push("");
  lines.push(
    `I pulled public reviews for ${name || "your community"} in ${
      location || "your area"
    } and filtered for security, pet waste, amenity misuse, and safety.`
  );
  lines.push("Here’s the snapshot:");
  lines.push(`• Security mentions: ${nl(counts.security)}`);
  lines.push(`• Pet-waste mentions: ${nl(counts.pet)}`);
  lines.push(`• Amenity-misuse mentions: ${nl(counts.amenity)}`);
  lines.push(`• Safety mentions: ${nl(counts.safety)}`);
  lines.push("");
  const add = (label, arr) => {
    if (!arr?.length) return;
    lines.push(`${label} examples:`);
    arr.slice(0, 3).forEach((r) => lines.push(`  – ${r.sentence}`));
    lines.push("");
  };
  add("Security", buckets.security);
  add("Amenity", buckets.amenity);
  add("Pet-waste", buckets.pet);
  add("Safety", buckets.safety);
  lines.push("How we help (VIDISKY):");
  lines.push("• AI + live agents monitoring your existing cameras in real time");
  lines.push("• Voice-down trespassers, alert staff, or call police per protocol");
  lines.push("• Evidence-grade reports for insurers and PD");
  lines.push("");
  lines.push(
    "Open to a 15-minute walkthrough to quantify impact (inc. pet-waste fines & amenity enforcement)?"
  );
  lines.push("– Stan");
  return lines.join("\n");
}
