import { useState, useMemo, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://cpotnzxzkuetxbwastda.supabase.co",
  "sb_publishable_NDmvU000k0LA6k-4HaN1PA_q801OnOe"
);
//--test



// ── DATA FETCHING ─────────────────────────────────────────────────────────────
function useRestaurants() {
  const [restaurants, setRestaurants] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // Fetch restaurants
        const { data: restData } = await supabase
          .from("restaurants")
          .select("*")
          .eq("is_active", true)
          .order("name");

        if (!restData) { setLoading(false); return; }

        // Fetch all categories
        const { data: catData } = await supabase
          .from("menu_categories")
          .select("*")
          .order("display_order");

        // Fetch all menu items
        const { data: itemData } = await supabase
          .from("menu_items")
          .select("*")
          .eq("is_available", true)
          .order("name");

        // Build restaurant objects matching the existing shape
        const built = restData.map(r => ({
          id: r.id,
          name: r.name,
          tagline: r.tagline,
          cuisine: r.cuisine,
          neighborhood: r.neighborhood,
          address: r.address,
          coverColor: r.cover_color,
          accentColor: r.accent_color,
          emoji: r.emoji,
          mapX: r.map_x,
          mapY: r.map_y,
          hours: r.hours || {},
          capacity: r.capacity,
          highlights: r.highlights || [],
          howToOrder: r.how_to_order,
          rsvp: {
            type: r.rsvp_type,
            label: r.rsvp_label,
            value: r.rsvp_value,
          },
          whatsapp: r.whatsapp,
          mapLink: r.map_link,
          appleMapsLink: r.apple_maps_link,
          overallRating: r.overall_rating,
          menu: (catData || [])
            .filter(c => c.restaurant_id === r.id)
            .map(cat => ({
              category: cat.name,
              items: (itemData || [])
                .filter(i => i.category_id === cat.id)
                .map(i => ({
                  name: i.name,
                  desc: i.description,
                  price: i.price,
                  rating: i.rating,
                  tags: i.tags || [],
                  isAvailable: i.is_available,
                }))
            }))
        }));

        setRestaurants(built);
      } catch (err) {
        console.error("Failed to load restaurants:", err);
      }
      setLoading(false);
    })();

    // Real-time updates for menu items (price/availability changes)
    const channel = supabase
      .channel("menu_changes")
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "menu_items" },
        () => {
          // Refetch everything when any item updates
          window.location.reload();
        }
      )
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "restaurants" },
        () => {
          window.location.reload();
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  return { restaurants, loading };
}
// ── BUDGET LOGIC ──────────────────────────────────────────────────────────────
function calcBudgetResults(totalBudget, guests, includeTip, drinksBudget, cuisineFilter, currency) {
  // Convert budget to NGN for calculations if user entered USD
  const budgetInNGN = currency === "USD" ? totalBudget * NGN_PER_USD : totalBudget;
  const drinksInNGN = currency === "USD" ? drinksBudget * NGN_PER_USD : drinksBudget;
  const foodOnlyBudget = budgetInNGN - drinksInNGN;
  const foodBudget = includeTip ? foodOnlyBudget / 1.2 : foodOnlyBudget;
  const perPerson = foodBudget / guests;

  const pool = cuisineFilter === "All"
    ? restaurants
    : restaurants.filter(r => r.cuisine === cuisineFilter);

  return pool.map(r => {
    const allItems = r.menu.flatMap(c => c.items);
    const byRating = arr => [...arr].sort((a, b) => b.rating - a.rating);

    // Detect price scale — if avg price > 500 it's in Naira thousands
    const avgPrice = allItems.reduce((s, i) => s + i.price, 0) / Math.max(allItems.length, 1);
    const isNaira  = avgPrice > 500;

    // Set thresholds based on price scale
    const mainMin      = isNaira ? 10000 : 15;
    const starterMax   = isNaira ? 15000 : 18;
    const starterMin   = isNaira ? 5000  : 7;
    const dessertMax   = isNaira ? 12000 : 14;

    const mains    = byRating(allItems.filter(i => i.price >= mainMin));
    const starters = byRating(allItems.filter(i => i.price < starterMax && i.price >= starterMin));
    const desserts = byRating(allItems.filter(i => i.price <= dessertMax));

    let meal = [], spent = 0;

    const bestMain = mains.find(i => i.price <= perPerson);
    if (bestMain) { meal.push({ ...bestMain, course: "Main" }); spent += bestMain.price; }

    const bestStarter = starters.find(i => spent + i.price <= perPerson);
    if (bestStarter) { meal.push({ ...bestStarter, course: "Starter" }); spent += bestStarter.price; }

    const bestDessert = desserts.find(i =>
      spent + i.price <= perPerson &&
      i.name !== bestStarter?.name &&
      i.name !== bestMain?.name
    );
    if (bestDessert) { meal.push({ ...bestDessert, course: "Dessert" }); spent += bestDessert.price; }

    // Fallback — find best rated items we can afford
    if (meal.length === 0) {
      const affordable = byRating(allItems.filter(i => i.price <= perPerson));
      if (affordable.length > 0) {
        let fallbackSpent = 0;
        const fallback = [];
        for (const item of affordable) {
          if (fallbackSpent + item.price <= perPerson && fallback.length < 3) {
            fallback.push({ ...item, course: "Dish" });
            fallbackSpent += item.price;
          }
        }
        meal = fallback;
        spent = fallbackSpent;
      }
    }

    const foodTotal  = spent * guests;
    const tipAmt     = foodTotal * 0.2;
    const grandTotal = foodTotal + tipAmt + drinksInNGN;
    const avgRating  = meal.length ? meal.reduce((s, i) => s + i.rating, 0) / meal.length : 0;
    const canAfford  = grandTotal <= budgetInNGN;
  const leftover   = budgetInNGN - grandTotal;

    // Normalise value score — rating quality relative to % of budget used
    const budgetUsed = grandTotal / totalBudget;
    const valueScore = avgRating > 0 && budgetUsed > 0
      ? Math.min(10, (avgRating / 5) * (1 / budgetUsed) * 5)
      : 0;

    return { r, meal, spent, foodTotal, tipAmt, drinksBudget: drinksInNGN, grandTotal, avgRating, canAfford, leftover, valueScore };
  }).sort((a, b) => {
    if (a.canAfford !== b.canAfford) return a.canAfford ? -1 : 1;
return b.valueScore - a.valueScore;
    });
  }
  
// ── GLOBAL STYLES ─────────────────────────────────────────────────────────────
const G = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
body{background:#0e0c09;color:#e8e0d0;font-family:'DM Sans',sans-serif;min-height:100vh;}
::-webkit-scrollbar{width:5px;}::-webkit-scrollbar-track{background:#0e0c09;}::-webkit-scrollbar-thumb{background:#2a2520;border-radius:3px;}
a{color:inherit;text-decoration:none;}
button{cursor:pointer;border:none;background:none;font-family:inherit;}
input,select{font-family:'DM Sans',sans-serif;}
.fi{animation:fi .42s ease forwards;}
@keyframes fi{from{opacity:0;transform:translateY(11px);}to{opacity:1;transform:none;}}
.ch{transition:transform .22s ease,box-shadow .22s ease;}
.ch:hover{transform:translateY(-4px);box-shadow:0 18px 48px rgba(0,0,0,.55);}
.bp{transition:filter .18s,transform .14s;}
.bp:hover{filter:brightness(1.14);transform:translateY(-1px);}
.fav-btn{transition:transform .2s,color .2s;}
.fav-btn:hover{transform:scale(1.2);}
@keyframes ripple{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.6);opacity:0}}
@keyframes heartPop{0%{transform:scale(1);}50%{transform:scale(1.5);}100%{transform:scale(1);}}
.heart-pop{animation:heartPop .3s ease;}
`;

// ── CURRENCY ──────────────────────────────────────────────────────────────────
const NGN_PER_USD = 1400;

function usePrice(currency) {
  const fmt = (ngn) => {
    if (currency === "USD") {
      return `$${(ngn / NGN_PER_USD).toFixed(2)}`;
    }
    return `₦${ngn.toLocaleString("en-NG")}`;
  };
  const fmtNum = (ngn) => currency === "USD" ? ngn / NGN_PER_USD : ngn;
  return { fmt, fmtNum, symbol: currency === "USD" ? "$" : "₦" };
}



// ── HELPERS ───────────────────────────────────────────────────────────────────
const Stars = ({ rating, size = 13 }) => {
  const full = Math.floor(rating);
  const half = rating % 1 >= 0.5;
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:1 }}>
      {[1,2,3,4,5].map(i => (
        <span key={i} style={{ fontSize:size, color:(i<=full||(i===full+1&&half))?"#f4c842":"#333", lineHeight:1 }}>
          {i<=full?"★":i===full+1&&half?"⯨":"☆"}
        </span>
      ))}
      <span style={{ fontSize:size-2, color:"#888", marginLeft:3 }}>{rating.toFixed(1)}</span>
    </span>
  );
};

const Chip = ({ label, accent }) => (
  <span style={{ fontSize:10, fontFamily:"'DM Mono',monospace", letterSpacing:"0.08em", padding:"2px 8px", borderRadius:2, background:accent+"1a", color:accent, border:`1px solid ${accent}33`, whiteSpace:"nowrap" }}>{label}</span>
);

// ── FAVORITES HOOK (persistent via storage API) ───────────────────────────────
function useFavorites() {
  const [favs, setFavs] = useState(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("DateDayz:favorites");
      if (saved) setFavs(new Set(JSON.parse(saved)));
    } catch (_) {}
    setLoaded(true);
  }, []);

  const toggle = useCallback((id) => {
    setFavs(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem("DateDayz:favorites", JSON.stringify([...next]));
      return next;
    });
}, []);

  return { favs, toggle, loaded };
}

// ── DISH REVIEWS & RATINGS ────────────────────────────────────────────────────
function useReviews() {
  const [reviews, setReviews] = useState({});
  const [myReviews, setMyReviews] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);

  const loadReviews = useCallback(async (dishKey) => {
    try {
      const { data } = await supabase
        .from("dish_reviews")
        .select("*")
        .eq("dish_key", dishKey)
        .order("created_at", { ascending: false });
      if (data) {
        setReviews(prev => ({ ...prev, [dishKey]: data }));
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem("datedayz:myreviews");
      if (v) setMyReviews(new Set(JSON.parse(v)));
    } catch (_) {}

    // Real-time subscription — update reviews instantly when anyone submits
    const channel = supabase
      .channel("dish_reviews_changes")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "dish_reviews" },
        (payload) => {
          const newReview = payload.new;
          setReviews(prev => ({
            ...prev,
            [newReview.dish_key]: [newReview, ...(prev[newReview.dish_key] || [])]
          }));
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  const submitReview = useCallback(async ({ dishKey, restaurantId, dishName, stars, reviewText, reviewerName, photoFile }) => {
    setSubmitting(true);
    try {
      let photoUrl = null;

      // Upload photo if provided
      if (photoFile) {
        const ext = photoFile.name.split(".").pop();
        const fileName = `${dishKey}-${Date.now()}.${ext}`;
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from("dish-photos")
          .upload(fileName, photoFile, { contentType: photoFile.type });
        if (!uploadError && uploadData) {
          const { data: urlData } = supabase.storage
            .from("dish-photos")
            .getPublicUrl(fileName);
          photoUrl = urlData.publicUrl;
        }
      }

      // Insert review
      const { data, error } = await supabase
        .from("dish_reviews")
        .insert({
          dish_key: dishKey,
          restaurant_id: restaurantId,
          dish_name: dishName,
          stars,
          review_text: reviewText || null,
          reviewer_name: reviewerName || null,
          photo_url: photoUrl,
        })
        .select()
        .single();

      if (!error && data) {
        setReviews(prev => ({
          ...prev,
          [dishKey]: [data, ...(prev[dishKey] || [])]
        }));
        setMyReviews(prev => {
          const next = new Set(prev);
          next.add(dishKey);
          localStorage.setItem("datedayz:myreviews", JSON.stringify([...next]));
          return next;
        });
      }
    } catch (err) {
      console.error("Review submit failed:", err);
    }
    setSubmitting(false);
  }, []);

  const getAggregatedRating = useCallback((dishKey, seedRating, seedCount = 12) => {
    const dishReviews = reviews[dishKey];
    if (!dishReviews || dishReviews.length === 0) {
      return { avg: seedRating, count: seedCount };
    }
    const totalSeedStars = seedRating * seedCount;
    const reviewStars = dishReviews.reduce((s, r) => s + r.stars, 0);
    const totalCount = seedCount + dishReviews.length;
    const avg = Math.round(((totalSeedStars + reviewStars) / totalCount) * 10) / 10;
    return { avg, count: totalCount };
  }, [reviews]);

  return { reviews, loadReviews, submitReview, myReviews, submitting, getAggregatedRating };
}

// ── REVIEW FORM & DISPLAY ─────────────────────────────────────────────────────
const DishReviewSection = ({ dishKey, restaurantId, dishName, seedRating, seedCount = 12, reviews, loadReviews, submitReview, myReviews, submitting, getAggregatedRating, accentColor }) => {
  const [open, setOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [stars, setStars] = useState(0);
  const [hoverStar, setHoverStar] = useState(0);
  const [reviewText, setReviewText] = useState("");
  const [reviewerName, setReviewerName] = useState("");
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const hasReviewed = myReviews.has(dishKey);
  const { avg, count } = getAggregatedRating(dishKey, seedRating, seedCount);
  const dishReviews = reviews[dishKey] || [];

  const handleOpen = () => {
    setOpen(true);
    loadReviews(dishKey);
  };

  const handlePhoto = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPhotoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setPhotoPreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async () => {
    if (stars === 0) return;
    await submitReview({ dishKey, restaurantId, dishName, stars, reviewText, reviewerName, photoFile });
    setShowForm(false);
    setStars(0);
    setReviewText("");
    setReviewerName("");
    setPhotoFile(null);
    setPhotoPreview(null);
  };

  return (
    <div style={{ marginTop:6 }}>
      {/* Rating summary row */}
      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
        <div style={{ display:"inline-flex", alignItems:"center", gap:2 }}>
          {[1,2,3,4,5].map(i => {
            const full = Math.floor(avg);
            const half = avg % 1 >= 0.5;
            return (
              <span key={i} style={{ fontSize:11, color:(i<=full||(i===full+1&&half))?"#f4c842":"#333", lineHeight:1 }}>
                {i<=full?"★":i===full+1&&half?"⯨":"☆"}
              </span>
            );
          })}
          <span style={{ fontSize:10, color:"#888", marginLeft:3 }}>{avg.toFixed(1)}</span>
        </div>
        <button onClick={handleOpen}
          style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:"#666", letterSpacing:"0.06em", background:"#1a1710", border:"1px solid #2a2520", borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>
          {count} REVIEWS
        </button>
        {!hasReviewed && (
          <button onClick={() => { handleOpen(); setShowForm(true); }}
            style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:accentColor, letterSpacing:"0.06em", background:accentColor+"15", border:`1px solid ${accentColor}44`, borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>
            + RATE & REVIEW
          </button>
        )}
        {hasReviewed && (
          <span style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:"#4ade80", letterSpacing:"0.06em" }}>✓ REVIEWED</span>
        )}
      </div>

      {/* Expanded reviews panel */}
      {open && (
        <div className="fi" style={{ marginTop:10, background:"#111009", border:"1px solid #2a2520", borderRadius:10, padding:"16px", display:"flex", flexDirection:"column", gap:12 }}>

          {/* Review form */}
          {showForm && !hasReviewed && (
            <div style={{ background:"#1a1710", borderRadius:8, padding:"14px", border:`1px solid ${accentColor}30` }}>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:accentColor, letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:12 }}>Your Review</p>

              {/* Star selector */}
              <div style={{ display:"flex", alignItems:"center", gap:4, marginBottom:12 }}>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:"#666", marginRight:4 }}>RATING:</span>
                {[1,2,3,4,5].map(s => (
                  <button key={s}
                    onMouseEnter={() => setHoverStar(s)}
                    onMouseLeave={() => setHoverStar(0)}
                    onClick={() => setStars(s)}
                    style={{ fontSize:22, color: s<=(hoverStar||stars)?"#f4c842":"#333", background:"none", border:"none", cursor:"pointer", padding:"0 2px", transition:"color .1s" }}>
                    ★
                  </button>
                ))}
                {stars > 0 && <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#888", marginLeft:4 }}>{["","Poor","Fair","Good","Great","Excellent"][stars]}</span>}
              </div>

              {/* Name input */}
              <input
                placeholder="Your name (optional)"
                value={reviewerName}
                onChange={e => setReviewerName(e.target.value)}
                style={{ width:"100%", padding:"9px 12px", background:"#0e0c09", border:"1px solid #2a2520", borderRadius:6, color:"#e8e0d0", fontSize:13, outline:"none", marginBottom:8, fontFamily:"'DM Sans',sans-serif" }}
              />

              {/* Review text */}
              <textarea
                placeholder="How was this dish? (optional)"
                value={reviewText}
                onChange={e => setReviewText(e.target.value)}
                rows={3}
                style={{ width:"100%", padding:"9px 12px", background:"#0e0c09", border:"1px solid #2a2520", borderRadius:6, color:"#e8e0d0", fontSize:13, outline:"none", resize:"none", marginBottom:8, fontFamily:"'DM Sans',sans-serif" }}
              />

              {/* Photo upload */}
              <div style={{ marginBottom:12 }}>
                <label style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:"#666", letterSpacing:"0.1em", display:"block", marginBottom:6 }}>ADD A PHOTO (optional)</label>
                {photoPreview ? (
                  <div style={{ position:"relative", display:"inline-block" }}>
                    <img src={photoPreview} alt="preview" style={{ width:80, height:80, objectFit:"cover", borderRadius:6, border:`1px solid ${accentColor}44` }}/>
                    <button onClick={() => { setPhotoFile(null); setPhotoPreview(null); }}
                      style={{ position:"absolute", top:-6, right:-6, background:"#e05252", color:"#fff", border:"none", borderRadius:"50%", width:18, height:18, fontSize:10, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      ✕
                    </button>
                  </div>
                ) : (
                  <label style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"8px 14px", background:"#0e0c09", border:"1px dashed #3a3228", borderRadius:6, cursor:"pointer", fontFamily:"'DM Mono',monospace", fontSize:10, color:"#666" }}>
                    📷 Upload photo
                    <input type="file" accept="image/*" onChange={handlePhoto} style={{ display:"none" }}/>
                  </label>
                )}
              </div>

              {/* Submit */}
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={handleSubmit} disabled={stars===0||submitting}
                  style={{ flex:1, padding:"10px", borderRadius:7, background: stars===0?"#2a2520":accentColor, color: stars===0?"#555":"#0e0c09", fontFamily:"'DM Mono',monospace", fontSize:11, letterSpacing:"0.07em", cursor: stars===0?"not-allowed":"pointer", transition:"all .2s" }}>
                  {submitting ? "SUBMITTING..." : "SUBMIT REVIEW"}
                </button>
                <button onClick={() => setShowForm(false)}
                  style={{ padding:"10px 16px", borderRadius:7, background:"#1e1c18", border:"1px solid #3a3228", color:"#888", fontFamily:"'DM Mono',monospace", fontSize:11, cursor:"pointer" }}>
                  CANCEL
                </button>
              </div>
            </div>
          )}

          {/* Show form button if not open */}
          {!showForm && !hasReviewed && (
            <button onClick={() => setShowForm(true)}
              style={{ padding:"10px", borderRadius:7, background:accentColor+"18", border:`1px solid ${accentColor}44`, color:accentColor, fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:"0.08em", cursor:"pointer" }}>
              + WRITE A REVIEW
            </button>
          )}

          {/* Reviews list */}
          {dishReviews.length === 0 ? (
            <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#555", textAlign:"center", padding:"12px 0" }}>No reviews yet — be the first!</p>
          ) : (
            dishReviews.map(rev => (
              <div key={rev.id} style={{ borderTop:"1px solid #1e1c18", paddingTop:12, display:"flex", gap:10 }}>
                {rev.photo_url && (
                  <img src={rev.photo_url} alt="dish" style={{ width:64, height:64, objectFit:"cover", borderRadius:7, flexShrink:0, border:"1px solid #2a2520" }}/>
                )}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
                    <div>
                      <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#e8e0d0" }}>
                        {rev.reviewer_name || "Anonymous diner"}
                      </span>
                      <span style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:"#444", marginLeft:8 }}>
                        {new Date(rev.created_at).toLocaleDateString("en-NG", { day:"numeric", month:"short", year:"numeric" })}
                      </span>
                    </div>
                    <div style={{ display:"flex", gap:1 }}>
                      {[1,2,3,4,5].map(i => (
                        <span key={i} style={{ fontSize:11, color:i<=rev.stars?"#f4c842":"#333" }}>★</span>
                      ))}
                    </div>
                  </div>
                  {rev.review_text && (
                    <p style={{ fontSize:12.5, color:"#999", lineHeight:1.5 }}>{rev.review_text}</p>
                  )}
                </div>
              </div>
            ))
          )}

          <button onClick={() => setOpen(false)}
            style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:"#555", letterSpacing:"0.08em", background:"none", border:"none", cursor:"pointer", textAlign:"center" }}>
            CLOSE ▲
          </button>
        </div>
      )}
    </div>
  );
};
function useRatings() {
  const [ratings, setRatings] = useState({});
  const [myVotes, setMyVotes] = useState(new Set());

  // Load all ratings from Supabase on mount
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase
          .from("dish_ratings")
          .select("dish_key, total_stars, count");
        if (data) {
          const map = {};
          data.forEach(row => {
            map[row.dish_key] = { total: row.total_stars, count: row.count };
          });
          setRatings(map);
        }
      } catch (_) {}
    })();

    // Load my votes from localStorage
    try {
      const v = localStorage.getItem("datedayz:myvotes");
      if (v) setMyVotes(new Set(JSON.parse(v)));
    } catch (_) {}
  }, []);

  const rate = useCallback(async (dishKey, stars, seedRating, seedCount) => {
    if (myVotes.has(dishKey)) return;

    // Optimistically update UI immediately
    setRatings(prev => {
      const existing = prev[dishKey] || { total: seedRating * seedCount, count: seedCount };
      return {
        ...prev,
        [dishKey]: { total: existing.total + stars, count: existing.count + 1 }
      };
    });

    // Save vote locally so user can't vote twice
    setMyVotes(prev => {
      const next = new Set(prev);
      next.add(dishKey);
      localStorage.setItem("datedayz:myvotes", JSON.stringify([...next]));
      return next;
    });

    // Upsert to Supabase
    try {
      const { data: existing } = await supabase
        .from("dish_ratings")
        .select("total_stars, count")
        .eq("dish_key", dishKey)
        .single();

      if (existing) {
        await supabase
          .from("dish_ratings")
          .update({
            total_stars: existing.total_stars + stars,
            count: existing.count + 1,
            updated_at: new Date().toISOString()
          })
          .eq("dish_key", dishKey);
      } else {
        const seedTotal = seedRating * seedCount;
        await supabase
          .from("dish_ratings")
          .insert({
            dish_key: dishKey,
            total_stars: seedTotal + stars,
            count: seedCount + 1
          });
      }
    } catch (err) {
      console.error("Rating save failed:", err);
    }
  }, [myVotes]);

  const getRating = useCallback((dishKey, seedRating, seedCount = 12) => {
    const r = ratings[dishKey];
    if (!r) return { avg: seedRating, count: seedCount };
    return {
      avg: Math.round((r.total / r.count) * 10) / 10,
      count: r.count
    };
  }, [ratings]);

  return { rate, getRating, myVotes };
}

const DishRating = ({ dishKey, seedRating, seedCount = 12, rate, getRating, myVotes }) => {
  const [hover, setHover] = useState(0);
  const { avg, count } = getRating(dishKey, seedRating, seedCount);
  const voted = myVotes.has(dishKey);

  return (
    <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
      {/* Current average */}
      <div style={{ display:"inline-flex", alignItems:"center", gap:2 }}>
        {[1,2,3,4,5].map(i => {
          const full = Math.floor(avg);
          const half = avg % 1 >= 0.5;
          return (
            <span key={i} style={{ fontSize:11, color:(i<=full||(i===full+1&&half))?"#f4c842":"#333", lineHeight:1 }}>
              {i<=full?"★":i===full+1&&half?"⯨":"☆"}
            </span>
          );
        })}
        <span style={{ fontSize:10, color:"#888", marginLeft:3 }}>{avg.toFixed(1)}</span>
        <span style={{ fontSize:9, color:"#555", marginLeft:2 }}>· {count} ratings</span>
      </div>

      {/* Rate button */}
      {!voted ? (
        <div style={{ display:"inline-flex", alignItems:"center", gap:1 }}
          onMouseLeave={() => setHover(0)}>
          <span style={{ fontSize:9, color:"#666", fontFamily:"'DM Mono',monospace", letterSpacing:"0.06em", marginRight:3 }}>RATE:</span>
          {[1,2,3,4,5].map(star => (
            <button key={star}
              onMouseEnter={() => setHover(star)}
              onClick={() => rate(dishKey, star, seedRating, seedCount)}
              style={{ fontSize:14, lineHeight:1, color: star <= (hover||0) ? "#f4c842" : "#333", background:"none", border:"none", cursor:"pointer", padding:"0 1px", transition:"color .1s" }}>
              ★
            </button>
          ))}
        </div>
      ) : (
        <span style={{ fontSize:9, color:"#4ade80", fontFamily:"'DM Mono',monospace", letterSpacing:"0.06em" }}>✓ RATED</span>
      )}
    </div>
  );
};

// ── HEART BUTTON ──────────────────────────────────────────────────────────────
const HeartBtn = ({ id, favs, toggle, size = 20 }) => {
  const [pop, setPop] = useState(false);
  const isFav = favs.has(id);
  const handleClick = (e) => {
    e.stopPropagation();
    toggle(id);
    setPop(true);
    setTimeout(() => setPop(false), 350);
  };
  return (
    <button onClick={handleClick} className={`fav-btn${pop?" heart-pop":""}`}
      title={isFav ? "Remove from favorites" : "Add to favorites"}
      style={{ fontSize:size, lineHeight:1, color:isFav?"#e05252":"#444", background:"none", padding:4, borderRadius:"50%", flexShrink:0 }}>
      {isFav ? "♥" : "♡"}
    </button>
  );
};
// ── WHATSAPP ──────────────────────────────────────────────────────────────────
const WhatsAppBtn = ({ phone, restaurantName, accentColor }) => {
  if (!phone) return null;

  const clean = phone.replace(/\D/g, "");
  const message = encodeURIComponent(
    `Hi! I discovered ${restaurantName} on DateDayz (datedayz.com) and I'd love to make a reservation. Could you help me with availability? 😊`
  );
  const url = `https://wa.me/${clean}?text=${message}`;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="bp"
      style={{
        display:"inline-flex", alignItems:"center", gap:8,
        background:"#25D366", color:"#fff",
        padding:"13px 24px", borderRadius:8,
        fontFamily:"'DM Mono',monospace", fontSize:12, letterSpacing:"0.05em",
        textDecoration:"none",
      }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
      </svg>
      Reserve via WhatsApp
    </a>
  );
};

// ── NAV ───────────────────────────────────────────────────────────────────────
const Nav = ({ view, setPage, favCount, currency, setCurrency }) => (
  <nav style={{ position:"sticky", top:0, zIndex:200, background:"rgba(14,12,9,.95)", backdropFilter:"blur(14px)", borderBottom:"1px solid #221f1a", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 12px", height:52, gap:8, overflowX:"hidden" }}>
<button onClick={() => setPage("home")} style={{ display:"flex", alignItems:"center", flexShrink:0 }}>
      <img src="/datedayznavlogo.svg" alt="DateDayz" style={{ height:22, width:"auto" }} />
    </button>
    <div style={{ display:"flex", gap:0, alignItems:"center", overflowX:"auto", flexShrink:1 }}>
      {[["home","Discover"],["map","Map"],["budget","Budget"],["favorites","♥"]].map(([k,l]) => (
        <button key={k} onClick={() => setPage(k)}
          style={{ fontFamily:"'DM Mono',monospace", fontSize:9, letterSpacing:"0.05em", padding:"6px 7px", textTransform:"uppercase", position:"relative", whiteSpace:"nowrap",
            color: view===k ? "#c8973a" : k==="favorites" && favCount>0 ? "#e05252" : "#666",
            borderBottom:`2px solid ${view===k?"#c8973a":"transparent"}`,
            transition:"all .2s" }}>
          {l}
          {k==="favorites" && favCount>0 && (
            <span style={{ position:"absolute", top:2, right:0, background:"#e05252", color:"#fff", borderRadius:"50%", width:12, height:12, fontSize:7, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'DM Mono',monospace" }}>
              {favCount}
            </span>
          )}
        </button>
      ))}
      <button onClick={() => setCurrency(c => c === "NGN" ? "USD" : "NGN")}
        style={{ fontFamily:"'DM Mono',monospace", fontSize:9, letterSpacing:"0.05em", padding:"4px 8px", borderRadius:5, border:"1px solid #3a3228", background:"#1a1710", color:"#c8973a", marginLeft:3, transition:"all .2s", whiteSpace:"nowrap", flexShrink:0 }}>
        {currency === "NGN" ? "₦" : "$"}
      </button>
    </div>
  </nav>
);

// ── HOME ──────────────────────────────────────────────────────────────────────
const Home = ({ setPage, favs, toggleFav, currency, restaurants }) => {
  const { fmt } = usePrice(currency);
  const [q, setQ] = useState("");
  const [f, setF] = useState("All");
  const cuisines = ["All", ...new Set(restaurants.map(r => r.cuisine))];
  const list = restaurants.filter(r =>
    (f==="All"||r.cuisine===f) &&
    [r.name,r.cuisine,r.neighborhood].some(s => s.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <div className="fi">
      {/* Hero */}
      <div style={{ textAlign:"center", padding:"64px 20px 48px", position:"relative" }}>
        <div style={{ position:"absolute", inset:0, background:"radial-gradient(ellipse 70% 55% at 50% 0%,#2a1a0435 0%,transparent 70%)", pointerEvents:"none" }}/>
<p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:"0.22em", color:"#c8973a", textTransform:"uppercase", marginBottom:20 }}>Your city's best tables</p>
        <img src="/datedayzmainlogo.svg" alt="DateDayz" style={{ height:220, width:"auto", marginBottom:24 }} />
        <p style={{ color:"#888", fontSize:15, maxWidth:420, margin:"0 auto 28px", lineHeight:1.65 }}>
          Not just the restaurant — every item on the menu. Find where to eat and exactly what to order.
        </p>
        <div style={{ display:"flex", gap:10, justifyContent:"center", marginBottom:30, flexWrap:"wrap" }}>
          <button onClick={() => setPage("map")} className="bp" style={{ display:"flex", alignItems:"center", gap:6, padding:"10px 18px", borderRadius:8, background:"#1a1710", border:"1px solid #3a3228", color:"#e8e0d0", fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:"0.1em" }}>🗺️ MAP VIEW</button>
          <button onClick={() => setPage("budget")} className="bp" style={{ display:"flex", alignItems:"center", gap:6, padding:"10px 18px", borderRadius:8, background:"#c8973a18", border:"1px solid #c8973a44", color:"#c8973a", fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:"0.1em" }}>💰 BUDGET PLANNER</button>
          {favs.size > 0 && (
            <button onClick={() => setPage("favorites")} className="bp" style={{ display:"flex", alignItems:"center", gap:6, padding:"10px 18px", borderRadius:8, background:"#e0525218", border:"1px solid #e0525244", color:"#e05252", fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:"0.1em" }}>♥ {favs.size} SAVED</button>
          )}
        </div>
        <div style={{ maxWidth:460, margin:"0 auto", position:"relative" }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search restaurant, cuisine, neighborhood…"
            style={{ width:"100%", padding:"13px 18px 13px 46px", borderRadius:8, background:"#1a1710", border:"1px solid #3a3228", color:"#e8e0d0", fontSize:14, outline:"none" }}/>
          <span style={{ position:"absolute", left:14, top:"50%", transform:"translateY(-50%)", fontSize:16, opacity:.4 }}>🔍</span>
        </div>
      </div>

      {/* Cuisine Filters */}
      <div style={{ display:"flex", gap:7, padding:"0 20px 28px", flexWrap:"wrap" }}>
        {cuisines.map(c => (
          <button key={c} onClick={() => setF(c)}
            style={{ padding:"6px 14px", borderRadius:20, fontSize:12, fontFamily:"'DM Mono',monospace", border:`1px solid ${f===c?"#c8973a":"#2a2520"}`, background:f===c?"#c8973a18":"transparent", color:f===c?"#c8973a":"#777", letterSpacing:"0.05em", whiteSpace:"nowrap", transition:"all .2s" }}>
            {c}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(275px,1fr))", gap:20, padding:"0 20px 80px", maxWidth:1100, margin:"0 auto" }}>
        {list.map((r, i) => (
          <div key={r.id} className="ch" style={{ background:"#141210", border:`1px solid ${favs.has(r.id)?"#e0525230":"#2a2520"}`, borderRadius:12, overflow:"hidden", position:"relative", animation:`fi .4s ease ${i*.07}s both`, cursor:"pointer" }}
            onClick={() => setPage({ view:"restaurant", id:r.id })}>
            {/* Fav badge */}
            {favs.has(r.id) && (
              <div style={{ position:"absolute", top:10, left:10, zIndex:2, background:"#e05252", borderRadius:5, padding:"2px 7px", fontFamily:"'DM Mono',monospace", fontSize:9, color:"#fff", letterSpacing:"0.08em" }}>♥ SAVED</div>
            )}
            <div style={{ height:152, background:r.coverColor, backgroundImage:`radial-gradient(ellipse at 30% 50%,${r.accentColor}28 0%,transparent 60%)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:60, position:"relative" }}>
              {r.emoji}
              <div style={{ position:"absolute", top:10, right:10 }}>
                <HeartBtn id={r.id} favs={favs} toggle={toggleFav} size={18} />
              </div>
              <div style={{ position:"absolute", bottom:10, left:10, background:"rgba(0,0,0,.72)", backdropFilter:"blur(8px)", borderRadius:5, padding:"3px 9px", fontFamily:"'DM Mono',monospace", fontSize:10, color:"#ddd" }}>{r.neighborhood}</div>
            </div>
            <div style={{ padding:"17px 18px 21px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:5 }}>
                <h2 style={{ fontFamily:"'Playfair Display',serif", fontSize:20, fontWeight:700, color:"#f0e8d8", lineHeight:1.2 }}>{r.name}</h2>
                <Stars rating={r.overallRating} size={12} />
              </div>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:r.accentColor, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:7 }}>{r.cuisine}</p>
              <p style={{ color:"#777", fontSize:13, lineHeight:1.55, marginBottom:13 }}>{r.tagline}</p>
              <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                {r.highlights.slice(0,3).map(h => <Chip key={h} label={h} accent={r.accentColor} />)}
              </div>
            </div>
          </div>
        ))}
        {list.length===0 && (
          <div style={{ gridColumn:"1/-1", textAlign:"center", padding:"60px 0", color:"#444" }}>
            <p style={{ fontSize:30, marginBottom:10 }}>🍽️</p>
            <p>No restaurants match your search.</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ── FAVORITES PAGE ────────────────────────────────────────────────────────────
const Favorites = ({ setPage, favs, toggleFav, currency, restaurants }) => {
  const { fmt } = usePrice(currency);
  const list = restaurants.filter(r => favs.has(r.id));

  return (
    <div className="fi" style={{ padding:"0 0 80px" }}>
      <div style={{ padding:"38px 20px 28px", maxWidth:900, margin:"0 auto" }}>
        <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#e05252", letterSpacing:"0.2em", textTransform:"uppercase", marginBottom:10 }}>Your Collection</p>
        <h1 style={{ fontFamily:"'Playfair Display',serif", fontSize:"clamp(26px,4vw,42px)", fontWeight:900, color:"#f0e8d8", letterSpacing:"-0.02em", marginBottom:8 }}>
          Saved Restaurants
        </h1>
        {list.length > 0
          ? <p style={{ color:"#777", fontSize:14 }}>{list.length} restaurant{list.length>1?"s":""} in your collection — saved across sessions.</p>
          : <p style={{ color:"#555", fontSize:14 }}>You haven't saved any restaurants yet. Tap ♡ on any restaurant to save it.</p>
        }
      </div>

      {list.length === 0 && (
        <div style={{ maxWidth:900, margin:"0 auto", padding:"0 20px" }}>
          <div style={{ background:"#141210", border:"1px solid #2a2520", borderRadius:14, padding:"56px 24px", textAlign:"center" }}>
            <p style={{ fontSize:48, marginBottom:16 }}>♡</p>
            <p style={{ fontFamily:"'Playfair Display',serif", fontSize:20, color:"#f0e8d8", marginBottom:10 }}>Nothing saved yet</p>
            <p style={{ color:"#666", fontSize:14, marginBottom:24 }}>Browse restaurants and tap the heart to save your favorites.</p>
            <button onClick={() => setPage("home")} className="bp"
              style={{ background:"#c8973a", color:"#0e0c09", padding:"12px 28px", borderRadius:8, fontFamily:"'DM Mono',monospace", fontSize:11, letterSpacing:"0.08em" }}>
              BROWSE RESTAURANTS →
            </button>
          </div>
        </div>
      )}

      {list.length > 0 && (
        <div style={{ maxWidth:900, margin:"0 auto", padding:"0 20px", display:"flex", flexDirection:"column", gap:14 }}>
          {list.map((r, i) => (
            <div key={r.id} className="fi" style={{ background:"#141210", border:`1px solid ${r.accentColor}30`, borderRadius:12, overflow:"hidden", animation:`fi .35s ease ${i*.06}s both` }}>
              <div style={{ display:"flex", gap:0, alignItems:"stretch" }}>
                {/* Color strip */}
                <div style={{ width:6, background:r.accentColor, flexShrink:0 }}/>
                {/* Emoji block */}
                <div style={{ width:80, flexShrink:0, background:r.coverColor, backgroundImage:`radial-gradient(circle,${r.accentColor}30 0%,transparent 70%)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:32 }}>
                  {r.emoji}
                </div>
                {/* Info */}
                <div style={{ flex:1, padding:"16px 18px", minWidth:0 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                    <div style={{ minWidth:0 }}>
                      <p style={{ fontFamily:"'DM Mono',monospace", fontSize:9.5, color:r.accentColor, letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:2 }}>{r.cuisine} · {r.neighborhood}</p>
                      <h3 style={{ fontFamily:"'Playfair Display',serif", fontSize:19, fontWeight:700, color:"#f0e8d8", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{r.name}</h3>
                      <p style={{ color:"#777", fontSize:12.5, marginTop:3, lineHeight:1.4 }}>{r.tagline}</p>
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:8, flexShrink:0 }}>
                      <HeartBtn id={r.id} favs={favs} toggle={toggleFav} size={20} />
                      <Stars rating={r.overallRating} size={12} />
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:7, marginTop:12, flexWrap:"wrap" }}>
                    <button onClick={() => setPage({ view:"restaurant", id:r.id })} className="bp"
                      style={{ background:r.accentColor, color:"#0e0c09", padding:"8px 16px", borderRadius:7, fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:"0.07em" }}>
                      VIEW MENU →
                    </button>
                    <button onClick={() => setPage("budget")} className="bp"
                      style={{ background:"#1e1c18", border:"1px solid #3a3228", color:"#aaa", padding:"8px 14px", borderRadius:7, fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:"0.06em" }}>
                      💰 BUDGET CHECK
                    </button>
                    <a href={r.mapLink} target="_blank" rel="noreferrer"
                      style={{ background:"#1e1c18", border:"1px solid #3a3228", color:"#aaa", padding:"8px 14px", borderRadius:7, fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:"0.06em", display:"inline-flex", alignItems:"center" }}>
                      🗺️ DIRECTIONS
                    </a>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {/* Quick compare */}
          {list.length >= 2 && (
            <div style={{ background:"#1a1710", border:"1px solid #2a2520", borderRadius:12, padding:"20px 22px" }}>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#888", letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:14 }}>Quick Compare — Your Saved Picks</p>
              <div style={{ display:"grid", gridTemplateColumns:`repeat(${Math.min(list.length,4)},1fr)`, gap:10 }}>
                {list.slice(0,4).map(r => (
                  <div key={r.id} style={{ textAlign:"center", padding:"12px 8px", background:"#141210", borderRadius:9, border:`1px solid ${r.accentColor}20` }}>
                    <div style={{ fontSize:24, marginBottom:6 }}>{r.emoji}</div>
                    <p style={{ fontFamily:"'Playfair Display',serif", fontSize:13, fontWeight:700, color:"#f0e8d8", marginBottom:3 }}>{r.name}</p>
                    <Stars rating={r.overallRating} size={11} />
                    <p style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:r.accentColor, marginTop:5, letterSpacing:"0.08em" }}>{r.cuisine}</p>
                    <p style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:"#666", marginTop:2 }}>{r.capacity} seats</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── MAP ───────────────────────────────────────────────────────────────────────
const MapView = ({ setPage, favs, toggleFav, restaurants }) => {
  const [sel, setSel] = useState(null);
  const selR = sel ? restaurants.find(r => r.id===sel) : null;

  const zones = [
    { name:"Midtown",  x:34, y:28, w:24, h:20 },
    { name:"Downtown", x:18, y:50, w:22, h:20 },
    { name:"Eastside", x:58, y:44, w:24, h:20 },
    { name:"Westside", x:6,  y:18, w:22, h:20 },
    { name:"Northside",x:46, y:8,  w:22, h:17 },
  ];
  const roads = [
    "M0,290 Q200,272 400,290 Q600,308 800,290",
    "M0,185 Q300,175 500,195 Q660,210 800,185",
    "M295,0 Q310,130 300,260 Q292,370 305,500",
    "M148,0 Q143,150 150,300 Q156,400 144,500",
    "M542,0 Q536,120 552,275 Q562,375 545,500",
    "M0,375 L800,375",
    "M0,118 Q400,108 800,128",
  ];

  return (
    <div className="fi" style={{ padding:"0 0 60px" }}>
      <div style={{ padding:"32px 20px 20px", maxWidth:920, margin:"0 auto" }}>
        <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#c8973a", letterSpacing:"0.2em", textTransform:"uppercase", marginBottom:8 }}>City Map</p>
        <h1 style={{ fontFamily:"'Playfair Display',serif", fontSize:"clamp(26px,4vw,42px)", fontWeight:900, color:"#f0e8d8", letterSpacing:"-0.02em", marginBottom:6 }}>Find your table</h1>
        <p style={{ color:"#777", fontSize:13 }}>Click any pin to preview · ♥ pins are your saved favorites</p>
      </div>

      <div style={{ maxWidth:920, margin:"0 auto", padding:"0 20px" }}>
        <div style={{ borderRadius:14, overflow:"hidden", border:"1px solid #2a2520", position:"relative" }}>
          <svg viewBox="0 0 800 500" style={{ width:"100%", display:"block", background:"#0c0b08" }}>
            <defs>
              <pattern id="g" width="44" height="44" patternUnits="userSpaceOnUse">
                <path d="M44 0L0 0 0 44" fill="none" stroke="#17140f" strokeWidth="0.6"/>
              </pattern>
              <radialGradient id="glow" cx="50%" cy="50%" r="60%">
                <stop offset="0%" stopColor="#c8973a" stopOpacity="0.03"/>
                <stop offset="100%" stopColor="#0c0b08" stopOpacity="0"/>
              </radialGradient>
            </defs>
            <rect width="800" height="500" fill="url(#g)"/>
            <rect width="800" height="500" fill="url(#glow)"/>

            {zones.map(z => (
              <g key={z.name}>
                <rect x={`${z.x}%`} y={`${z.y}%`} width={`${z.w}%`} height={`${z.h}%`} rx="5"
                  fill="#c8973a" fillOpacity="0.03" stroke="#c8973a" strokeOpacity="0.1" strokeWidth="1"/>
                <text x={`${z.x+z.w/2}%`} y={`${z.y+z.h/2}%`} textAnchor="middle" dominantBaseline="middle"
                  fill="#c8973a" fillOpacity="0.18" style={{ fontSize:10.5, fontFamily:"DM Mono,monospace", letterSpacing:"0.14em" }}>
                  {z.name.toUpperCase()}
                </text>
              </g>
            ))}

            {roads.map((d,i) => <path key={`ra${i}`} d={d} fill="none" stroke="#211d16" strokeWidth={i<5?9:5} strokeLinecap="round"/>)}
            {roads.map((d,i) => <path key={`rb${i}`} d={d} fill="none" stroke="#1a1710" strokeWidth={i<5?6:3} strokeLinecap="round"/>)}

            {restaurants.map(r => {
              const cx = (r.mapX/100)*800;
              const cy = (r.mapY/100)*500;
              const active = sel===r.id;
              const isFav  = favs.has(r.id);
              return (
                <g key={r.id} style={{ cursor:"pointer" }} onClick={() => setSel(sel===r.id?null:r.id)}>
                  {active && <>
                    <circle cx={cx} cy={cy} r="28" fill={r.accentColor} fillOpacity="0.08"
                      style={{ animation:"ripple 1.8s ease-in-out infinite" }}/>
                    <circle cx={cx} cy={cy} r="20" fill={r.accentColor} fillOpacity="0.12"/>
                  </>}
                  {isFav && <circle cx={cx} cy={cy} r="18" fill="#e05252" fillOpacity="0.15" stroke="#e05252" strokeOpacity="0.3" strokeWidth="1"/>}
                  <circle cx={cx+1.5} cy={cy+1.5} r="15" fill="rgba(0,0,0,.45)"/>
                  <circle cx={cx} cy={cy} r="15"
                    fill={active?r.accentColor:"#161310"}
                    stroke={isFav?"#e05252":r.accentColor}
                    strokeWidth={active?0:isFav?2.5:2}/>
                  <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="middle" style={{ fontSize:15 }}>{r.emoji}</text>
                  {isFav && <text x={cx+11} y={cy-11} textAnchor="middle" style={{ fontSize:10 }}>♥</text>}
                  {active && (
                    <g>
                      <rect x={cx-68} y={cy-62} width="136" height="40" rx="6"
                        fill="#161310" stroke={r.accentColor} strokeOpacity=".35" strokeWidth="1"/>
                      <text x={cx} y={cy-46} textAnchor="middle" fill="#f0e8d8"
                        style={{ fontSize:12.5, fontFamily:"Playfair Display,serif", fontWeight:700 }}>{r.name}</text>
                      <text x={cx} y={cy-30} textAnchor="middle" fill="#888"
                        style={{ fontSize:10, fontFamily:"DM Mono,monospace" }}>
                        {r.neighborhood} · ★{r.overallRating}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>

          <div style={{ position:"absolute", bottom:14, right:14, background:"rgba(12,11,8,.92)", backdropFilter:"blur(10px)", border:"1px solid #2a2520", borderRadius:8, padding:"10px 13px" }}>
            <p style={{ fontFamily:"'DM Mono',monospace", fontSize:8.5, color:"#555", letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:6 }}>Locations</p>
            {restaurants.map(r => (
              <div key={r.id} style={{ display:"flex", alignItems:"center", gap:5, marginBottom:3 }}>
                <span style={{ fontSize:11 }}>{r.emoji}</span>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color: favs.has(r.id)?"#e05252":"#999" }}>{r.name}{favs.has(r.id)?" ♥":""}</span>
              </div>
            ))}
          </div>
        </div>

        {selR && (
          <div className="fi" style={{ marginTop:18, background:"#141210", border:`1px solid ${selR.accentColor}3a`, borderRadius:12, padding:"22px", display:"flex", gap:18, flexWrap:"wrap", alignItems:"flex-start" }}>
            <div style={{ width:58, height:58, borderRadius:10, flexShrink:0, background:selR.coverColor, backgroundImage:`radial-gradient(circle,${selR.accentColor}38 0%,transparent 70%)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:28 }}>{selR.emoji}</div>
            <div style={{ flex:1, minWidth:180 }}>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:9.5, color:selR.accentColor, letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:3 }}>{selR.cuisine} · {selR.neighborhood}</p>
              <h2 style={{ fontFamily:"'Playfair Display',serif", fontSize:22, fontWeight:700, color:"#f0e8d8", marginBottom:3 }}>{selR.name}</h2>
              <p style={{ color:"#777", fontSize:12, marginBottom:7 }}>{selR.tagline}</p>
              <p style={{ color:"#666", fontSize:11, fontFamily:"'DM Mono',monospace" }}>📍 {selR.address}</p>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:8, flexShrink:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <Stars rating={selR.overallRating} size={13} />
                <HeartBtn id={selR.id} favs={favs} toggle={toggleFav} size={20} />
              </div>
              <button onClick={() => setPage({ view:"restaurant", id:selR.id })} className="bp"
                style={{ background:selR.accentColor, color:"#0e0c09", padding:"10px 18px", borderRadius:7, fontFamily:"'DM Mono',monospace", fontSize:10.5, letterSpacing:"0.06em" }}>
                FULL MENU →
              </button>
              <div style={{ display:"flex", gap:6 }}>
                <a href={selR.mapLink} target="_blank" rel="noreferrer" style={{ flex:1, textAlign:"center", background:"#1e1c18", border:"1px solid #3a3228", borderRadius:6, padding:"7px 8px", fontFamily:"'DM Mono',monospace", fontSize:9.5, color:"#aaa" }}>🗺 Google</a>
                <a href={selR.appleMapsLink} target="_blank" rel="noreferrer" style={{ flex:1, textAlign:"center", background:"#1e1c18", border:"1px solid #3a3228", borderRadius:6, padding:"7px 8px", fontFamily:"'DM Mono',monospace", fontSize:9.5, color:"#aaa" }}>🍎 Apple</a>
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop:20, display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))", gap:9 }}>
          {restaurants.map(r => (
            <button key={r.id} onClick={() => setSel(r.id===sel?null:r.id)}
              style={{ background:sel===r.id?r.accentColor+"12":"#141210", border:`1px solid ${sel===r.id?r.accentColor+"55":favs.has(r.id)?"#e0525240":"#2a2520"}`, borderRadius:8, padding:"11px 13px", textAlign:"left", transition:"all .2s" }}>
              <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                <span style={{ fontSize:17 }}>{r.emoji}</span>
                <div style={{ flex:1 }}>
                  <p style={{ fontFamily:"'Playfair Display',serif", fontSize:13, fontWeight:700, color:"#f0e8d8" }}>{r.name}</p>
                  <p style={{ fontFamily:"'DM Mono',monospace", fontSize:9.5, color:r.accentColor }}>{r.neighborhood}</p>
                </div>
                {favs.has(r.id) && <span style={{ fontSize:11, color:"#e05252" }}>♥</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── BUDGET ────────────────────────────────────────────────────────────────────
const Budget = ({ setPage, currency, restaurants }) => {
  const { fmt, fmtNum, symbol } = usePrice(currency);
  const [budget, setBudget]       = useState(100);
  const [guests, setGuests]       = useState(2);
  const [tip, setTip]             = useState(true);
  const [drinks, setDrinks]       = useState(0);
  const [cuisine, setCuisine]     = useState("All");
  const [ran, setRan]             = useState(false);

  const cuisines = ["All", ...new Set(restaurants.map(r => r.cuisine))];
  const foodPortion = budget - drinks;
  const results = useMemo(
    () => ran ? calcBudgetResults(budget, guests, tip, drinks, cuisine, currency) : [],
    [ran, budget, guests, tip, drinks, cuisine, currency]
  );
  const yes = results.filter(r => r.canAfford);
  const no  = results.filter(r => !r.canAfford);
  const rankColors = ["#4ade80","#86efac","#fbbf24","#fb923c"];
  const reset = () => setRan(false);

  // Drinks slider: max is half the budget
  const maxDrinks = Math.floor(budget * 0.6);

  return (
    <div className="fi" style={{ padding:"0 0 80px" }}>
      <div style={{ padding:"38px 20px 28px", maxWidth:680, margin:"0 auto" }}>
        <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#c8973a", letterSpacing:"0.2em", textTransform:"uppercase", marginBottom:10 }}>Smart Planner</p>
        <h1 style={{ fontFamily:"'Playfair Display',serif", fontSize:"clamp(26px,4vw,42px)", fontWeight:900, color:"#f0e8d8", letterSpacing:"-0.02em", marginBottom:8 }}>Budget Calculator</h1>
        <p style={{ color:"#777", fontSize:14, lineHeight:1.65 }}>Set your total budget, split off drinks, filter by cuisine, and we'll rank every restaurant by value.</p>
      </div>

      <div style={{ maxWidth:680, margin:"0 auto", padding:"0 20px 28px" }}>
        <div style={{ background:"#141210", border:"1px solid #2a2520", borderRadius:14, padding:"26px 24px 22px" }}>

          {/* Row 1: Budget + Guests */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:18, marginBottom:22 }}>
            <div>
              <label style={{ fontFamily:"'DM Mono',monospace", fontSize:9.5, color:"#c8973a", letterSpacing:"0.16em", textTransform:"uppercase", display:"block", marginBottom:7 }}>Total Budget ({currency})</label>
              <div style={{ position:"relative" }}>
                <span style={{ position:"absolute", left:11, top:"50%", transform:"translateY(-50%)", color:"#888", fontSize:17 }}>{currency === "USD" ? "$" : "₦"}</span>
                <input type="number" min={10} max={5000} value={budget}
                  onChange={e => { setBudget(Number(e.target.value)||0); reset(); }}
                  style={{ width:"100%", padding:"11px 11px 11px 26px", background:"#1a1710", border:"1px solid #3a3228", borderRadius:7, color:"#f0e8d8", fontSize:24, fontFamily:"'Playfair Display',serif", fontWeight:700, outline:"none" }}/>
              </div>
            </div>
            <div>
              <label style={{ fontFamily:"'DM Mono',monospace", fontSize:9.5, color:"#c8973a", letterSpacing:"0.16em", textTransform:"uppercase", display:"block", marginBottom:7 }}>Party Size</label>
              <div style={{ display:"flex", gap:6 }}>
                {[1,2,3,4,5,6].map(n => (
                  <button key={n} onClick={() => { setGuests(n); reset(); }}
                    style={{ flex:1, padding:"11px 0", borderRadius:7, fontSize:14, fontWeight:600, background:guests===n?"#c8973a":"#1a1710", color:guests===n?"#0e0c09":"#777", border:`1px solid ${guests===n?"#c8973a":"#3a3228"}`, transition:"all .15s" }}>{n}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Drinks Budget Slider */}
          <div style={{ marginBottom:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <label style={{ fontFamily:"'DM Mono',monospace", fontSize:9.5, color:"#5b8dd9", letterSpacing:"0.16em", textTransform:"uppercase" }}>
                🍷 Drinks Budget
              </label>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:13, color: drinks>0?"#5b8dd9":"#555" }}>${drinks}</span>
                {drinks > 0 && (
                  <button onClick={() => { setDrinks(0); reset(); }}
                    style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:"#555", background:"#1e1c18", border:"1px solid #3a3228", borderRadius:4, padding:"2px 6px" }}>CLEAR</button>
                )}
              </div>
            </div>
            <div style={{ position:"relative", padding:"6px 0" }}>
              {/* Track */}
              <div style={{ height:4, background:"#1e1c18", borderRadius:2, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${maxDrinks>0?(drinks/maxDrinks)*100:0}%`, background:"linear-gradient(90deg,#3a5fa0,#5b8dd9)", borderRadius:2, transition:"width .1s" }}/>
              </div>
              <input type="range" min={0} max={maxDrinks} step={5} value={drinks}
                onChange={e => { setDrinks(Number(e.target.value)); reset(); }}
                style={{ position:"absolute", inset:0, width:"100%", opacity:0, cursor:"pointer", height:"100%" }}/>
              {/* Tick labels */}
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:5 }}>
                {[0, Math.floor(maxDrinks*0.25), Math.floor(maxDrinks*0.5), Math.floor(maxDrinks*0.75), maxDrinks].map(v => (
                  <button key={v} onClick={() => { setDrinks(v); reset(); }}
                    style={{ fontFamily:"'DM Mono',monospace", fontSize:8.5, color: drinks===v?"#5b8dd9":"#444", background:"none", padding:0 }}>
                    ${v}
                  </button>
                ))}
              </div>
            </div>
            {drinks > 0 && (
              <div style={{ background:"#1a2030", border:"1px solid #3a5fa040", borderRadius:7, padding:"9px 13px", marginTop:8, display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:6 }}>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10.5, color:"#5b8dd9" }}>🍷 ${drinks} for drinks ({guests} guests)</span>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10.5, color:"#c8973a" }}>🍽️ ${foodPortion} left for food</span>
              </div>
            )}
          </div>

          {/* Cuisine Filter */}
          <div style={{ marginBottom:20 }}>
            <label style={{ fontFamily:"'DM Mono',monospace", fontSize:9.5, color:"#c8973a", letterSpacing:"0.16em", textTransform:"uppercase", display:"block", marginBottom:8 }}>Filter by Cuisine</label>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {cuisines.map(c => (
                <button key={c} onClick={() => { setCuisine(c); reset(); }}
                  style={{ padding:"6px 13px", borderRadius:20, fontSize:11.5, fontFamily:"'DM Mono',monospace", border:`1px solid ${cuisine===c?"#c8973a":"#2a2520"}`, background:cuisine===c?"#c8973a18":"transparent", color:cuisine===c?"#c8973a":"#666", letterSpacing:"0.05em", whiteSpace:"nowrap", transition:"all .18s" }}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* Tip Toggle */}
          <div style={{ display:"flex", alignItems:"center", gap:11, marginBottom:22 }}>
            <button onClick={() => { setTip(!tip); reset(); }}
              style={{ width:42, height:22, borderRadius:11, position:"relative", background:tip?"#c8973a":"#2a2520", transition:"background .2s", flexShrink:0 }}>
              <span style={{ position:"absolute", top:2, left:tip?22:2, width:18, height:18, borderRadius:9, background:"#fff", transition:"left .2s" }}/>
            </button>
            <span style={{ fontSize:13, color:"#999" }}>Include 20% tip in total</span>
            <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#555", marginLeft:"auto" }}>
              {tip ? `food budget: $${(foodPortion/1.2).toFixed(0)}` : `food budget: $${foodPortion}`}
            </span>
          </div>

          {/* Summary bar */}
          <div style={{ background:"#1a1710", borderRadius:7, padding:"10px 14px", marginBottom:18 }}>
            <div style={{ display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
              <span style={{ fontSize:12.5, color:"#777" }}>${budget} total · {guests} {guests===1?"guest":"guests"}{cuisine!=="All"?` · ${cuisine}`:""}</span>
              <div style={{ display:"flex", gap:12 }}>
                {drinks>0 && <span style={{ fontSize:12, color:"#5b8dd9", fontFamily:"'DM Mono',monospace" }}>🍷 ${drinks}</span>}
                <span style={{ fontSize:12, color:"#c8973a", fontFamily:"'DM Mono',monospace" }}>🍽️ ~${((tip?foodPortion/1.2:foodPortion)/guests).toFixed(0)}/person food</span>
              </div>
            </div>
          </div>

          <button onClick={() => setRan(true)} className="bp"
            style={{ width:"100%", padding:"15px", borderRadius:9, background:"linear-gradient(135deg,#c8973a,#dea848)", color:"#0e0c09", fontFamily:"'DM Mono',monospace", fontSize:12, letterSpacing:"0.1em", fontWeight:600 }}>
            FIND THE BEST VALUE →
          </button>
        </div>
      </div>

      {/* Results */}
      {ran && (
        <div className="fi" style={{ maxWidth:680, margin:"0 auto", padding:"0 20px" }}>
          {results.length===0 && (
            <div style={{ background:"#141210", border:"1px solid #2a2520", borderRadius:12, padding:"32px", textAlign:"center" }}>
              <p style={{ fontSize:28, marginBottom:10 }}>🍴</p>
              <p style={{ fontFamily:"'Playfair Display',serif", fontSize:18, color:"#f0e8d8", marginBottom:6 }}>No {cuisine!=="All"?cuisine+" ":""} restaurants to compare</p>
              <p style={{ color:"#777", fontSize:13 }}>Try selecting "All" cuisines or adjusting your budget.</p>
            </div>
          )}

          {yes.length===0 && results.length>0 && (
            <div style={{ background:"#180e0e", border:"1px solid #4a2020", borderRadius:12, padding:"28px", textAlign:"center", marginBottom:16 }}>
              <p style={{ fontSize:30, marginBottom:10 }}>😬</p>
              <p style={{ fontFamily:"'Playfair Display',serif", fontSize:19, color:"#f0e8d8", marginBottom:6 }}>Budget's tight for {guests} {guests===1?"guest":"guests"}</p>
              <p style={{ color:"#777", fontSize:13 }}>Try increasing your budget, reducing drinks, or lowering party size.</p>
            </div>
          )}

          {yes.length>0 && (
            <>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
                <span style={{ fontSize:18 }}>✅</span>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#4ade80", letterSpacing:"0.15em", textTransform:"uppercase" }}>
                  {yes.length} restaurant{yes.length>1?"s":""} within budget — ranked by value
                </span>
              </div>
              {yes.map((res, i) => <ResultCard key={res.r.id} res={res} rank={i+1} color={rankColors[i]||"#aaa"} setPage={setPage} guests={guests} currency={currency} />)}
            </>
          )}

          {no.length>0 && (
            <>
              <div style={{ display:"flex", alignItems:"center", gap:8, margin:"26px 0 14px" }}>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#666", letterSpacing:"0.15em", textTransform:"uppercase" }}>
                  ↑ just over budget — worth the stretch?
                </span>
              </div>
              {no.slice(0,2).map(res => <ResultCard key={res.r.id} res={res} rank={null} color="#555" setPage={setPage} guests={guests} currency={currency} dim />)}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const ResultCard = ({ res, rank, color, setPage, guests, dim, currency }) => {
  const { fmt } = usePrice(currency || "NGN");
  const [open, setOpen] = useState(rank === 1);
  const { r, meal, foodTotal, tipAmt, drinksBudget, grandTotal, avgRating, canAfford, leftover, valueScore } = res;

  return (
    <div style={{ background:dim?"#111009":"#141210", border:`1px solid ${dim?"#2a2520":color+"3a"}`, borderRadius:12, marginBottom:14, overflow:"hidden", opacity:dim?.78:1 }}>
      <div style={{ padding:"18px 18px 14px", display:"flex", gap:13, alignItems:"flex-start" }}>
        {rank && (
          <div style={{ width:30, height:30, borderRadius:6, flexShrink:0, background:color+"18", border:`1px solid ${color}44`, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'DM Mono',monospace", fontSize:12, color, fontWeight:700 }}>#{rank}</div>
        )}
        <div style={{ flex:1 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:8 }}>
            <div>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:9.5, color:r.accentColor, letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:2 }}>{r.emoji} {r.cuisine} · {r.neighborhood}</p>
              <h3 style={{ fontFamily:"'Playfair Display',serif", fontSize:19, fontWeight:700, color:"#f0e8d8" }}>{r.name}</h3>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontFamily:"'Playfair Display',serif", fontSize:28, fontWeight:900, color:canAfford?color:"#e05252", lineHeight:1 }}>{fmt(grandTotal)}</div>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:8.5, color:"#555", letterSpacing:"0.07em" }}>TOTAL</p>
            </div>
          </div>

          {/* Stats grid */}
          <div style={{ display:"flex", gap:7, flexWrap:"wrap", marginTop:10 }}>
            {[
              ["PER PERSON", fmt(grandTotal/guests)],
              ["FOOD", fmt(foodTotal)],
              ["TIP", fmt(tipAmt)],
              drinksBudget>0 ? ["🍷 DRINKS", fmt(drinksBudget), "#5b8dd9"] : null,
              canAfford ? ["LEFT OVER", fmt(leftover), color] : null,
            ].filter(Boolean).map(([k,v,c]) => (
              <div key={k} style={{ background:c?c+"12":"#1a1710", border:c&&c!==color?`1px solid ${c}28`:"none", borderRadius:6, padding:"5px 10px" }}>
                <p style={{ fontFamily:"'DM Mono',monospace", fontSize:8.5, color:"#555", marginBottom:1 }}>{k}</p>
                <p style={{ fontFamily:"'DM Mono',monospace", fontSize:12.5, color:c||"#e8e0d0" }}>{v}</p>
              </div>
            ))}
            <div style={{ background:"#1a1710", borderRadius:6, padding:"5px 10px" }}>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:8.5, color:"#555", marginBottom:1 }}>AVG RATING</p>
              <Stars rating={avgRating||0} size={11} />
            </div>
          </div>

          {canAfford && (
            <div style={{ marginTop:11 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:8.5, color:"#555", letterSpacing:"0.1em" }}>VALUE SCORE</span>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:8.5, color }}>{(valueScore||0).toFixed(1)}/10</span>
              </div>
              <div style={{ height:3, background:"#1a1710", borderRadius:2, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${Math.min(100,(valueScore||0)*10)}%`, background:`linear-gradient(90deg,${color}55,${color})`, borderRadius:2, transition:"width .7s ease" }}/>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ borderTop:"1px solid #1e1c18" }}>
        <button onClick={() => setOpen(!open)}
          style={{ width:"100%", padding:"10px 18px", display:"flex", justifyContent:"space-between", alignItems:"center", fontFamily:"'DM Mono',monospace", fontSize:9.5, color:"#777", letterSpacing:"0.1em", textTransform:"uppercase" }}>
          <span>🍽️ Suggested Order for {guests} {guests===1?"guest":"guests"}</span>
          <span style={{ transition:"transform .2s", transform:open?"rotate(180deg)":"none" }}>▾</span>
        </button>

        {open && (
          <div className="fi" style={{ padding:"0 18px 18px" }}>
            {meal.length===0
              ? <p style={{ color:"#555", fontSize:12 }}>No affordable combo found within this budget.</p>
              : <>
                  <div style={{ display:"flex", flexDirection:"column", gap:7, marginBottom:12 }}>
                    {meal.map((item, idx) => (
                      <div key={idx} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"#1a1710", borderRadius:7, padding:"9px 13px", gap:10 }}>
                        <div style={{ flex:1 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:2 }}>
                            <Chip label={item.course} accent={r.accentColor} />
                            <span style={{ fontFamily:"'Playfair Display',serif", fontSize:14, color:"#f0e8d8" }}>{item.name}</span>
                          </div>
                          <p style={{ fontSize:11.5, color:"#666", lineHeight:1.4 }}>{item.desc}</p>
                        </div>
                        <div style={{ textAlign:"right", flexShrink:0 }}>
                          <p style={{ fontFamily:"'DM Mono',monospace", fontSize:13, color:r.accentColor }}>{fmt(item.price)}</p>
                          <Stars rating={item.rating} size={10} />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Full breakdown */}
                  <div style={{ background:color+"0a", border:`1px solid ${color}1a`, borderRadius:8, padding:"12px 14px", marginBottom:12 }}>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))", gap:10 }}>
                      {[
                        ["Food /person", fmt(foodTotal/guests)],
                        [`Food ×${guests}`, fmt(foodTotal)],
                        ["Tip (20%)", fmt(tipAmt)],
                        ...(drinksBudget>0?[["🍷 Drinks", fmt(drinksBudget)]]: []),
                        ["Grand Total", fmt(grandTotal)],
                        ...(canAfford?[["Your Budget", fmt(grandTotal+leftover)]]: []),
                      ].map(([k,v]) => (
                        <div key={k}>
                          <p style={{ fontFamily:"'DM Mono',monospace", fontSize:8.5, color:"#555", marginBottom:2 }}>{k.toUpperCase()}</p>
                          <p style={{ fontFamily:"'DM Mono',monospace", fontSize:14, color:k==="Grand Total"?color:k.includes("Budget")?"#4ade80":"#e8e0d0" }}>{v}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
            }
            <button onClick={() => setPage({ view:"restaurant", id:r.id })} className="bp"
              style={{ width:"100%", padding:"11px", borderRadius:7, background:r.accentColor, color:"#0e0c09", fontFamily:"'DM Mono',monospace", fontSize:10.5, letterSpacing:"0.07em" }}>
              VIEW FULL MENU →
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ── RESTAURANT PAGE ───────────────────────────────────────────────────────────
const Restaurant = ({ id, setPage, favs, toggleFav, currency, reviews, loadReviews, submitReview, myReviews, submitting, getAggregatedRating, restaurants }) => {
  const { fmt } = usePrice(currency);

  // Load all reviews for this restaurant when page opens
  useEffect(() => {
    const r = restaurants.find(x => x.id === id);
    if (!r) return;
    const allItems = r.menu.flatMap(c => c.items);
    allItems.forEach(item => {
      loadReviews(`${id}:${item.name}`);
    });
  }, [id]);

  // Load all reviews for this restaurant when page opens
  useEffect(() => {
    const r = restaurants.find(x => x.id === id);
    if (!r) return;
    const allItems = r.menu.flatMap(c => c.items);
    allItems.forEach(item => {
      loadReviews(`${id}:${item.name}`);
    });
  }, [id]);
  const r = restaurants.find(x => x.id===id);
  const [tab, setTab] = useState("menu");
  if (!r) return <p style={{ padding:40, color:"#666" }}>Not found.</p>;
  const top = [...r.menu.flatMap(c=>c.items)].sort((a,b)=>b.rating-a.rating).slice(0,3);

  return (
    <div className="fi">
      <div style={{ padding:"18px 20px 0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <button onClick={() => setPage("home")} style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#777", letterSpacing:"0.08em" }}>← BACK</button>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color: favs.has(r.id)?"#e05252":"#555" }}>
            {favs.has(r.id)?"♥ SAVED":"♡ SAVE"}
          </span>
          <HeartBtn id={r.id} favs={favs} toggle={toggleFav} size={24} />
        </div>
      </div>

      <div style={{ margin:"16px 20px", borderRadius:14, height:"clamp(170px,27vw,270px)", background:r.coverColor, backgroundImage:`radial-gradient(ellipse at 20% 60%,${r.accentColor}48 0%,transparent 55%),radial-gradient(ellipse at 80% 20%,${r.accentColor}1a 0%,transparent 50%)`, display:"flex", alignItems:"flex-end", justifyContent:"space-between", padding:"24px 28px", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", right:28, top:"50%", transform:"translateY(-50%)", fontSize:96, opacity:.13 }}>{r.emoji}</div>
        <div>
          <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:r.accentColor, letterSpacing:"0.16em", textTransform:"uppercase", marginBottom:7 }}>{r.cuisine} · {r.neighborhood}</p>
          <h1 style={{ fontFamily:"'Playfair Display',serif", fontSize:"clamp(26px,5vw,50px)", fontWeight:900, color:"#f0e8d8", lineHeight:1.05, letterSpacing:"-0.02em" }}>{r.name}</h1>
          <p style={{ color:"#bbb", fontSize:13, marginTop:5 }}>{r.tagline}</p>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ fontFamily:"'Playfair Display',serif", fontSize:38, fontWeight:900, color:r.accentColor, lineHeight:1 }}>{r.overallRating}</div>
          <Stars rating={r.overallRating} size={13} />
          <p style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:"#777", marginTop:3, letterSpacing:"0.08em" }}>OVERALL</p>
        </div>
      </div>

      <div style={{ display:"flex", gap:7, padding:"0 20px 22px", overflowX:"auto" }}>
        {r.highlights.map(h => <Chip key={h} label={h} accent={r.accentColor} />)}
      </div>
      <div style={{ display:"flex", borderBottom:"1px solid #2a2520", padding:"0 20px", marginBottom:28 }}>
        {[["menu","Menu"],["info","Info & Hours"],["visit","Visit"]].map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding:"11px 17px", fontFamily:"'DM Mono',monospace", fontSize:10.5, letterSpacing:"0.1em", textTransform:"uppercase", color:tab===k?r.accentColor:"#666", borderBottom:`2px solid ${tab===k?r.accentColor:"transparent"}`, transition:"all .2s", marginBottom:-1 }}>
            {l}
          </button>
        ))}
      </div>

      <div style={{ padding:"0 20px", maxWidth:840, margin:"0 auto" }}>
        {tab==="menu" && (
          <div className="fi">
            <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:r.accentColor, letterSpacing:"0.16em", textTransform:"uppercase", marginBottom:14 }}>★ Top Rated</p>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))", gap:11, marginBottom:36 }}>
              {top.map(item => (
                <div key={item.name} style={{ background:r.accentColor+"0e", border:`1px solid ${r.accentColor}28`, borderRadius:9, padding:"15px 16px" }}>
                  <Stars rating={item.rating} size={12} />
                  <p style={{ fontFamily:"'Playfair Display',serif", fontSize:15, fontWeight:700, color:"#f0e8d8", marginTop:5, marginBottom:3 }}>{item.name}</p>
                  <p style={{ fontSize:12, color:"#777", lineHeight:1.4 }}>{item.desc}</p>
                  <p style={{ fontFamily:"'DM Mono',monospace", fontSize:12.5, color:r.accentColor, marginTop:9 }}>{fmt(item.price)}</p>
                </div>
              ))}
            </div>
            {r.menu.map(sec => (
              <div key={sec.category} style={{ marginBottom:36 }}>
                <div style={{ display:"flex", alignItems:"center", gap:11, marginBottom:17 }}>
                  <h3 style={{ fontFamily:"'Playfair Display',serif", fontSize:22, fontWeight:700, color:"#f0e8d8" }}>{sec.category}</h3>
                  <div style={{ flex:1, height:1, background:"#2a2520" }}/>
                </div>
                {sec.items.map(item => (
                  <div key={item.name} style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"14px 0", borderBottom:"1px solid #1e1c18", gap:14 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:7, flexWrap:"wrap", marginBottom:3 }}>
                        <span style={{ fontFamily:"'Playfair Display',serif", fontSize:16, fontWeight:600, color:"#f0e8d8" }}>{item.name}</span>
                        {item.tags.map(t => <Chip key={t} label={t} accent={r.accentColor} />)}
                      </div>
                      <p style={{ color:"#666", fontSize:12.5, lineHeight:1.5, marginBottom:5 }}>{item.desc}</p>
                      <DishReviewSection
                        dishKey={`${id}:${item.name}`}
                        restaurantId={id}
                        dishName={item.name}
                        seedRating={item.rating}
                        reviews={reviews}
                        loadReviews={loadReviews}
                        submitReview={submitReview}
                        myReviews={myReviews}
                        submitting={submitting}
                        getAggregatedRating={getAggregatedRating}
                        accentColor={r.accentColor}
                      />
                    </div>
                    <p style={{ fontFamily:"'DM Mono',monospace", fontSize:14, color:r.accentColor, flexShrink:0 }}>{fmt(item.price)}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {tab==="info" && (
          <div className="fi" style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))", gap:16, paddingBottom:60 }}>
            <div style={{ background:"#141210", border:"1px solid #2a2520", borderRadius:11, padding:"22px" }}>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:r.accentColor, letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:14 }}>Hours</p>
              {Object.entries(r.hours).map(([d,t]) => (
                <div key={d} style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:"1px solid #1e1c18", fontSize:13 }}>
                  <span style={{ color:"#aaa" }}>{d}</span>
                  <span style={{ color:"#e8e0d0", fontFamily:"'DM Mono',monospace", fontSize:11.5 }}>{t}</span>
                </div>
              ))}
            </div>
            <div style={{ background:"#141210", border:"1px solid #2a2520", borderRadius:11, padding:"22px" }}>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:r.accentColor, letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:14 }}>Capacity</p>
              <div style={{ textAlign:"center", padding:"14px 0" }}>
                <div style={{ fontFamily:"'Playfair Display',serif", fontSize:52, fontWeight:900, color:"#f0e8d8", lineHeight:1 }}>{r.capacity}</div>
                <p style={{ color:"#777", fontSize:12, marginTop:5 }}>seats</p>
              </div>
            </div>
            <div style={{ background:"#141210", border:"1px solid #2a2520", borderRadius:11, padding:"22px", gridColumn:"1/-1" }}>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:r.accentColor, letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:14 }}>Ordering & Pickup</p>
              <p style={{ color:"#ccc", fontSize:14, lineHeight:1.7 }}>{r.howToOrder}</p>
            </div>
          </div>
        )}
        {tab==="visit" && (
          <div className="fi" style={{ paddingBottom:60 }}>
            <div style={{ background:"#141210", border:"1px solid #2a2520", borderRadius:11, padding:"24px", marginBottom:16 }}>
              <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:r.accentColor, letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:14 }}>Reservations & RSVP</p>
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                {r.rsvp.value
                  ? <a href={r.rsvp.type==="phone"?`tel:${r.rsvp.value}`:r.rsvp.value} target={r.rsvp.type==="link"?"_blank":undefined} rel="noreferrer" className="bp"
                      style={{ display:"inline-flex", alignItems:"center", gap:7, background:r.accentColor, color:"#0e0c09", padding:"12px 24px", borderRadius:7, fontFamily:"'DM Mono',monospace", fontSize:12, letterSpacing:"0.05em" }}>
                      {r.rsvp.type==="phone"?"📞":"🔗"} {r.rsvp.label}
                    </a>
                  : <p style={{ background:"#1a1710", borderRadius:7, padding:"14px 18px", color:"#aaa", fontSize:13 }}>🚶 {r.rsvp.label} — no advance booking needed.</p>
                }
                <WhatsAppBtn phone={r.whatsapp} restaurantName={r.name} accentColor={r.accentColor} />
                {r.whatsapp && (
                  <p style={{ fontFamily:"'DM Mono',monospace", fontSize:9.5, color:"#555", letterSpacing:"0.06em" }}>
                    VIA DATEDAYZ · MESSAGE OPENS WITH YOUR REFERRAL
                  </p>
                )}
              </div>
            </div>
            <div style={{ background:"#141210", border:"1px solid #2a2520", borderRadius:11, overflow:"hidden" }}>
              <div style={{ height:200, background:`linear-gradient(135deg,#1a1710 0%,${r.accentColor}0e 100%)`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10, position:"relative" }}>
                <div style={{ fontSize:44 }}>📍</div>
                <p style={{ fontFamily:"'Playfair Display',serif", fontSize:17, color:"#f0e8d8" }}>{r.name}</p>
                <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10.5, color:"#777", letterSpacing:"0.08em" }}>{r.address}</p>
                <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", opacity:.05 }}>
                  {[...Array(8)].map((_,i)=><line key={`v${i}`} x1={`${(i+1)*12.5}%`} y1="0" x2={`${(i+1)*12.5}%`} y2="100%" stroke="#c8973a" strokeWidth="1"/>)}
                  {[...Array(5)].map((_,i)=><line key={`h${i}`} x1="0" y1={`${(i+1)*16.7}%`} x2="100%" y2={`${(i+1)*16.7}%`} stroke="#c8973a" strokeWidth="1"/>)}
                </svg>
              </div>
              <div style={{ padding:"18px 20px", display:"flex", gap:10, flexWrap:"wrap" }}>
                <a href={r.mapLink} target="_blank" rel="noreferrer" className="bp"
                  style={{ flex:1, minWidth:130, display:"flex", alignItems:"center", justifyContent:"center", gap:7, background:r.accentColor, color:"#0e0c09", padding:"11px 16px", borderRadius:7, fontFamily:"'DM Mono',monospace", fontSize:11 }}>
                  🗺️ Google Maps
                </a>
                <a href={r.appleMapsLink} target="_blank" rel="noreferrer" className="bp"
                  style={{ flex:1, minWidth:130, display:"flex", alignItems:"center", justifyContent:"center", gap:7, background:"#1e1c18", color:"#e8e0d0", border:"1px solid #3a3228", padding:"11px 16px", borderRadius:7, fontFamily:"'DM Mono',monospace", fontSize:11 }}>
                  🍎 Apple Maps
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("home");
  const [currency, setCurrency] = useState("NGN");
  const { favs, toggle: toggleFav, loaded } = useFavorites();
  const { reviews, loadReviews, submitReview, myReviews, submitting, getAggregatedRating } = useReviews();
  const { restaurants, loading: restaurantsLoading } = useRestaurants();
  const view = typeof page==="string" ? page : page.view;

  if (!loaded || restaurantsLoading) return (
    <>
      <style>{G}</style>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100vh", gap:16 }}>
        <img src="/datedayznavlogo.svg" alt="DateDayz" style={{ height:40, width:"auto", opacity:0.8 }} />
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:20 }}>🍽️</span>
          <span style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#555", letterSpacing:"0.14em" }}>LOADING DATEDAYZ…</span>
        </div>
      </div>
    </>
  );

  return (
    <>
      <style>{G}</style>
      <Nav view={view} setPage={setPage} favCount={favs.size} currency={currency} setCurrency={setCurrency} />
      {view==="home"       && <Home       setPage={setPage} favs={favs} toggleFav={toggleFav} currency={currency} restaurants={restaurants} />}
      {view==="map"        && <MapView    setPage={setPage} favs={favs} toggleFav={toggleFav} restaurants={restaurants} />}
      {view==="budget"     && <Budget     setPage={setPage} currency={currency} restaurants={restaurants} />}
      {view==="favorites"  && <Favorites  setPage={setPage} favs={favs} toggleFav={toggleFav} currency={currency} restaurants={restaurants} />}
      {view==="restaurant" && <Restaurant id={page.id} setPage={setPage} favs={favs} toggleFav={toggleFav} currency={currency} reviews={reviews} loadReviews={loadReviews} submitReview={submitReview} myReviews={myReviews} submitting={submitting} getAggregatedRating={getAggregatedRating} restaurants={restaurants} />}
      <footer style={{ borderTop:"1px solid #1e1c18", padding:"22px", textAlign:"center" }}>
        <p style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#333", letterSpacing:"0.12em" }}>
          DateDayz · EVERY DISH, RATED · {new Date().getFullYear()}
        </p>
      </footer>
    </>
  );
}
