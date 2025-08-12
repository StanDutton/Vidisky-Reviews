import React, { useMemo, useRef, useState } from "react";

// --- categories & keywords ---
const CATEGORIES = {
  security: [
    "security","unsafe","trespass","trespasser","loiter","loitering","crime",
    "stolen","break-in","break in","broken into","burglary","vandal","vandalism",
    "police","weapon","gun","knife","assault","threatening","suspicious",
    "car break","catalytic","porch pirate"
  ],
  pet: [
    "pet waste","dog poop","poop","didn't pick up","did not pick up","feces",
    "droppings","dogs everywhere","mess from dogs","dog waste"
  ],
  noise: [
    "amenity misuse","party","parties","pool party","after hours","after-hours",
    "noise","noisy","loud","non-residents","guests using","gym crowd","smoking by pool",
    "smoke at pool","parking unauthorized","illegal parking","trash dumping","dumpster",
    "package theft","mailroom"
  ]
};

// keep a flat list in case you need it elsewhere
const ALL_KEYWORDS = [...new Set(Object.values(CATEGORIES).flat())];

function tokenize(text){
  return (text||"")
    .replace(/\n+/g,"\n")
    .split(/\n|\.|!|\?|\r/g)
    .map(s=>s.trim())
    .filter(Boolean);
}

function classify(sentence){
  const s = sentence.toLowerCase();
  const hits = [];
  for (const [cat, words] of Object.entries(CATEGORIES)){
    if (words.some(w => s.includes(w))) hits.push(cat);
  }
  return hits;
}

export default function App(){
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  // default to your backend URL
  const [proxyBase, setProxyBase] = useState("https://vidisky-reviews-1.onrender.com");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState([]); // [{text,url,source}]
  const reportRef = useRef(null);

  // Extract per-sentence matches with categories
  const filtered = useMemo(()=>{
    const out=[];
    for(const r of results){
      for(const sentence of tokenize(r.text)){
        const cats = classify(sentence);
        if (cats.length){
          out.push({ sentence, url:r.url, source:r.source, cats });
        }
      }
    }
    return out;
  },[results]);

  // Counts per category + total
  const counts = useMemo(()=>{
    const base = { total: filtered.length, security:0, pet:0, noise:0 };
    for (const row of filtered){
      if (row.cats.includes("security")) base.security++;
      if (row.cats.includes("pet")) base.pet++;
      if (row.cats.includes("noise")) base.noise++;
    }
    return base;
  },[filtered]);

  async function fetchJson(path){
    const base = proxyBase.replace(/\/$/, "");
    const res = await fetch(`${base}${path}`);
    if(!res.ok) throw new Error(`${path} failed (${res.status})`);
    return (await res.json())||[];
  }

  async function onFetch(){
    try{
      setError("");
      if(!name || !location) throw new Error("Please enter name and location.");
      if(!proxyBase) throw new Error("Please set Proxy Base URL.");
      setLoading(true);

      const q = `?name=${encodeURIComponent(name)}&location=${encodeURIComponent(location)}`;

      // Google (Playwright scraper) + ApartmentRatings
      const [g, ar] = await Promise.allSettled([
        fetchJson(`/google-scrape${q}&max=80`),
        fetchJson(`/apartmentratings${q}`)
      ]);

      const list=[];
      if (g.status==="fulfilled") list.push(...g.value.map(x=>({...x, source:"Google"})));
      if (ar.status==="fulfilled") list.push(...ar.value.map(x=>({...x, source:"ApartmentRatings"})));

      // dedupe by text
      const seen=new Set(); const uniq=[];
      for(const it of list){
        const k=(it.text||"").toLowerCase();
        if(!k || seen.has(k)) continue; seen.add(k); uniq.push(it);
      }
      setResults(uniq);
    }catch(e){
      setError(e.message||"Fetch failed");
    }finally{
      setLoading(false);
    }
  }

  function copyEmail(){
    const lines=[];
    lines.push(`Subject: Quick security takeaways – ${name||"Property"} (${location||"City, ST"})`);
    lines.push(""); lines.push("Hi [Name] —"); lines.push("");
    lines.push(`I pulled public reviews for ${name||"your community"} in ${location||"your area"} and filtered for security, pet waste, and parties/noise.`);
    lines.push(`Signals found: ${counts.total}`);
    lines.push(`• Security: ${counts.security}`);
    lines.push(`• Pet issues: ${counts.pet}`);
    lines.push(`• Parties/Noise: ${counts.noise}`);
    lines.push("");
    filtered.slice(0,10).forEach(r=>{
      const tag = r.cats.join(", ");
      lines.push(`– ${r.sentence}  [${tag}]`);
    });
    lines.push(""); lines.push("How we help (VIDISKY):");
    lines.push("• AI + live agents monitor your existing cameras in real time");
    lines.push("• Voice-down trespassers, alert staff, or call police per protocol");
    lines.push("• Evidence-grade reports for insurers and PD");
    lines.push(""); lines.push("Open to a 15-minute walkthrough to quantify impact?"); lines.push("– Stan");

    const text = lines.join("\n");
    navigator.clipboard?.writeText(text).catch(()=>{
      const ta=document.createElement("textarea");
      ta.value=text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
    });
    alert("Email summary copied.");
  }

  async function exportPdf(){
    const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
      import("jspdf"),
      import("html2canvas"),
    ]);
    const node = reportRef.current; if(!node) return;
    const canvas = await html2canvas(node,{scale:2,backgroundColor:"#ffffff"});
    const img = canvas.toDataURL("image/png");
    const pdf = new jsPDF({orientation:"p",unit:"pt",format:"a4"});
    const pw=pdf.internal.pageSize.getWidth(), ph=pdf.internal.pageSize.getHeight();
    const iw=pw-40, ih=canvas.height*(iw/canvas.width);
    if(ih<ph-40){ pdf.addImage(img,"PNG",20,20,iw,ih); }
    else{ let left=ih,pos=20; pdf.addImage(img,"PNG",20,pos,iw,ih); left-=ph-40; while(left>0){ pdf.addPage(); pos=20-(ih-left); pdf.addImage(img,"PNG",20,pos,iw,ih); left-=ph-40; } }
    pdf.save(`${(name||"Property").replace(/\W+/g,"-")}-${(location||"Location").replace(/\W+/g,"-")}-VIDISKY-Review-Summary.pdf`);
  }

  const box={border:"1px solid #e5e7eb",borderRadius:12,padding:16,background:"white"};
  const label={fontSize:12,color:"#475569"};

  return (
    <div style={{minHeight:"100vh",background:"#f8fafc",color:"#0f172a"}}>
      <div style={{maxWidth:960,margin:"0 auto",padding:16}}>
        <h1 style={{fontWeight:700,marginBottom:8}}>VIDISKY Review Summarizer</h1>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <label style={{display:"flex",flexDirection:"column",gap:6}}>
            <span style={label}>Apartment name</span>
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="(e.g., 30 West Apartments)" style={{border:"1px solid #cbd5e1",borderRadius:8,padding:8}}/>
          </label>
          <label style={{display:"flex",flexDirection:"column",gap:6}}>
            <span style={label}>Location (City, ST)</span>
            <input value={location} onChange={e=>setLocation(e.target.value)} placeholder="(e.g., Bradenton, FL)" style={{border:"1px solid #cbd5e1",borderRadius:8,padding:8}}/>
          </label>
        </div>

        <div style={{marginTop:8}}>
          <label style={{display:"flex",flexDirection:"column",gap:6}}>
            <span style={label}>Proxy Base URL</span>
            <input value={proxyBase} onChange={e=>setProxyBase(e.target.value)} placeholder="https://vidisky-reviews-1.onrender.com" style={{border:"1px solid #cbd5e1",borderRadius:8,padding:8}}/>
          </label>
        </div>

        <div style={{display:"flex",gap:8,marginTop:12}}>
          <button onClick={onFetch} disabled={loading} style={{background:"black",color:"white",borderRadius:10,padding:"8px 12px"}}>{loading?"Fetching…":"Fetch & Summarize"}</button>
          <button onClick={copyEmail} style={{border:"1px solid #e2e8f0",borderRadius:10,padding:"8px 12px"}}>Copy Email</button>
          <button onClick={exportPdf} style={{border:"1px solid #e2e8f0",borderRadius:10,padding:"8px 12px"}}>Export PDF</button>
        </div>

        {/* Category counts */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:8,marginTop:12}}>
          {[
            ["Security", counts.security],
            ["Pet issues", counts.pet],
            ["Parties/Noise", counts.noise],
          ].map(([label,count])=>(
            <div key={label} style={{...box, padding:12}}>
              <div style={{fontSize:12,color:"#64748b"}}>{label}</div>
              <div style={{fontWeight:700,fontSize:22}}>{count}</div>
            </div>
          ))}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr",gap:16,marginTop:16}}>
          <div ref={reportRef} style={box}>
            <div style={{fontWeight:600,marginBottom:8}}>
  Findings for {name || "(name)"}{location ? `, ${location}` : ""}
</div>
            <div style={{ fontSize: 13, color: '#475569', marginBottom: 8 }}>
              Relevant sentences found: <b>{counts.total}</b>
              {" "}| Security: <b>{counts.security}</b>
              {" "}· Pet: <b>{counts.pet}</b>
              {" "}· Parties/Noise: <b>{counts.noise}</b>
            </div>
            {error && <div style={{marginBottom:8,color:"#b91c1c"}}>{error}</div>}
            {!filtered.length ? (
              <div style={{fontSize:13,color:"#64748b"}}>No explicit mentions detected.</div>
            ) : (
              <ul style={{margin:"8px 0 0 18px"}}>
                {filtered.slice(0,40).map((q,i)=>(
                  <li key={i} style={{marginBottom:6,fontSize:14,lineHeight:"20px"}}>
                    “{q.sentence}”
                    {q.url && <a href={q.url} target="_blank" rel="noreferrer" style={{color:"#64748b",textDecoration:"underline",marginLeft:6}}>source</a>}
                    <span style={{color:"#94a3b8",fontSize:12,marginLeft:6}}>
                      [{q.cats.join(", ")}]
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
