import React, { useState } from "react";

export default function App() {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchReviews = async () => {
    if (!name || !location || !proxyUrl) {
      alert("Please fill in all fields");
      return;
    }
    setLoading(true);
    setSummary("");

    try {
      const googleRes = await fetch(
        `${proxyUrl}/google-reviews?name=${encodeURIComponent(name)}&location=${encodeURIComponent(location)}`
      );
      const googleData = await googleRes.json();

      // This can be expanded to also fetch apartments.com + apartmentratings.com
      const allReviews = [];
      if (googleData?.[0]?.reviews_data) {
        googleData[0].reviews_data.forEach(r => allReviews.push(r.review_text));
      }

      // Filter relevant categories
      const keywords = ["security", "safety", "trespass", "loiter", "crime", "pet waste", "dog poop", "amenity"];
      const filtered = allReviews.filter(r =>
        keywords.some(k => r.toLowerCase().includes(k))
      );

      if (filtered.length === 0) {
        setSummary("No relevant issues found in the reviews.");
      } else {
        setSummary(filtered.join("\n\n"));
      }
    } catch (err) {
      console.error("Error fetching reviews:", err);
      setSummary("Error fetching reviews");
    } finally {
      setLoading(false);
    }
  };

  const copyToEmail = () => {
    const emailBody = encodeURIComponent(`Hi,\n\nHere’s a summary of review issues for ${name}, ${location}:\n\n${summary}`);
    window.location.href = `mailto:?subject=Review Summary for ${name}&body=${emailBody}`;
  };

  const exportToPDF = () => {
    const blob = new Blob([summary], { type: "application/pdf" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${name}-${location}-summary.pdf`;
    link.click();
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: "800px", margin: "auto" }}>
      <h1>VIDISKY Review Summary</h1>

      <label>
        Apartment Name:
        <input value={name} onChange={e => setName(e.target.value)} style={{ width: "100%", marginBottom: "1rem" }} />
      </label>

      <label>
        Location:
        <input value={location} onChange={e => setLocation(e.target.value)} style={{ width: "100%", marginBottom: "1rem" }} />
      </label>

      <label>
        Proxy Base URL:
        <input value={proxyUrl} onChange={e => setProxyUrl(e.target.value)} placeholder="https://your-backend.onrender.com" style={{ width: "100%", marginBottom: "1rem" }} />
      </label>

      <button onClick={fetchReviews} disabled={loading} style={{ marginRight: "1rem" }}>
        {loading ? "Loading..." : "Fetch & Summarize"}
      </button>
      <button onClick={copyToEmail} style={{ marginRight: "1rem" }}>Copy to Email</button>
      <button onClick={exportToPDF}>Export to PDF</button>

      {summary && (
        <div style={{ marginTop: "2rem", whiteSpace: "pre-wrap" }}>
          <h2>Summary</h2>
          <p>{summary}</p>
        </div>
      )}
    </div>
  );
}
