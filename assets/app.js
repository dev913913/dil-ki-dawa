(() => {
  "use strict";

  const MAX_TEXT = 600;
  const RECENT_LIMIT = 8;
  const FAV_LIMIT = 30;
  const FAV_KEY = "dkd:favs:v1";
  const CHAT_TIMEOUT_MS = 20000;
  const VIDEO_TIMEOUT_MS = 10000;
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  const $ = (id) => document.getElementById(id);
  const els = {
    chips: $("moodChips"),
    input: $("userInput"),
    count: $("charCount"),
    submit: $("submitBtn"),
    clear: $("clearBtn"),
    card: $("songCard"),
    placeholder: $("placeholder"),
    placeholderText: $("placeholderText"),
    loading: $("loading"),
    info: $("songInfo"),
    name: $("songName"),
    meta: $("songMeta"),
    why: $("songWhy"),
    care: $("careNote"),
    again: $("againBtn"),
    save: $("saveBtn"),
    copy: $("copyBtn"),
    yt: $("ytEmbed"),
    ytStatus: $("ytStatus"),
    ytLink: $("ytLink"),
    favSection: $("favSection"),
    favList: $("favList"),
  };

  const DEFAULT_PLACEHOLDER = "Your song awaits...";

  // Same wording check as the server (api/_lib/song.js). Running it here too means
  // the support note still appears when the network or the server is down.
  const CARE_EN =
    /\b(suicid\w*|kill myself|end my life|end it all|want to die|wanna die|don'?t want to (live|be alive)|self[- ]?harm|hurt myself|khud ko (khatam|maar)\w*|jaan de\w*|marna chah\w*|mar jana chah\w*)\b/i;
  const CARE_HI = /(आत्महत्या|मरना चाह|मर जाना चाह|जान दे|खुद को खत्म|खुद को मार)/;
  /** True when the text contains a worrying phrase (English, Hinglish or Hindi). */
  const looksLikeCrisis = (text) => CARE_EN.test(text) || CARE_HI.test(text);

  let selectedMoods = [];
  let recentSongs = [];
  let currentSong = null;
  let inFlight = false;
  let chatController = null;
  let requestId = 0; // lets us ignore answers that arrive after Clear / a newer request

  // ── tiny safe storage helpers (storage can throw in private mode) ──
  /** Reads saved songs from this browser; returns [] if storage is empty, blocked or corrupt. */
  function loadFavs() {
    try {
      const raw = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((f) => f && typeof f.song === "string" && f.song)
        .slice(0, FAV_LIMIT)
        .map((f) => ({
          song: String(f.song).slice(0, 120),
          singer: String(f.singer || "").slice(0, 100),
          film: String(f.film || "").slice(0, 100),
          year: String(f.year || "").slice(0, 4),
          searchQuery: String(f.searchQuery || f.song).slice(0, 150),
        }));
    } catch {
      return [];
    }
  }

  /** Saves favourites to this browser; returns false if storage is unavailable. */
  function storeFavs(list) {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  }

  let favs = loadFavs();
  const favKey = (s) => `${s.song}|${s.singer}`.toLowerCase();

  // ── helpers ──
  /** Builds a YouTube search link for a song. */
  function ytSearchUrl(query) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  }

  /** Singer, film and year that are present, in order. */
  function metaParts(song) {
    return [song.singer, song.film, song.year].filter(Boolean);
  }

  /** Shows or hides the support note. It lives outside the song area, so it also works on errors. */
  function setCare(on) {
    els.care.hidden = !on;
  }

  /** Removes any player so an old video cannot keep playing out of sight. */
  function stopVideo() {
    els.yt.textContent = "";
    els.yt.hidden = true;
    els.ytStatus.textContent = "";
  }

  function setBusy(busy) {
    inFlight = busy;
    els.card.setAttribute("aria-busy", String(busy));
    els.again.disabled = busy;
    updateSubmitState();
  }

  /** Updates the "n / 600" counter. */
  function updateCharCount() {
    const n = els.input.value.length;
    els.count.textContent = `${n} / ${MAX_TEXT}`;
    els.count.classList.toggle("warn", n > MAX_TEXT * 0.87);
  }

  /** Enables the main button only when there is a mood or text and nothing is loading. */
  function updateSubmitState() {
    const hasInput = els.input.value.trim().length > 0 || selectedMoods.length > 0;
    els.submit.disabled = inFlight || !hasInput;
  }

  /** Shows a message in the empty song card (also used for errors). */
  function showPlaceholder(text, isError) {
    els.placeholderText.textContent = text;
    els.placeholder.classList.toggle("is-error", Boolean(isError));
    els.placeholder.style.display = "block";
  }

  // ── mood chips ──
  els.chips.addEventListener("click", (e) => {
    const chip = e.target.closest(".mood-chip");
    if (!chip) return;
    const on = chip.getAttribute("aria-pressed") !== "true";
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("selected", on);
    selectedMoods = [...els.chips.querySelectorAll('.mood-chip[aria-pressed="true"]')].map((c) =>
      c.textContent.trim()
    );
    updateSubmitState();
  });

  // ── find a song ──
  /** Asks the server for a song using the chosen moods and typed text. */
  async function findSong() {
    if (inFlight) return;

    const userText = els.input.value.trim().slice(0, MAX_TEXT);
    if (!userText && !selectedMoods.length) {
      showPlaceholder("Please share what you're feeling or pick a mood first.", true);
      return;
    }

    const myId = ++requestId;
    const localCare = looksLikeCrisis(userText);
    setCare(localCare);
    stopVideo();
    chatController = new AbortController();
    const timer = setTimeout(() => chatController.abort(), CHAT_TIMEOUT_MS);

    setBusy(true);
    els.placeholder.style.display = "none";
    els.info.classList.remove("on");
    els.loading.classList.add("on");
    els.card.classList.add("active");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedMoods,
          userText,
          avoidSongs: recentSongs.slice(-RECENT_LIMIT),
        }),
        signal: chatController.signal,
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        /* non-JSON reply, handled below */
      }

      if (myId !== requestId) return; // cleared or superseded

      setCare(localCare || (data && data.needsCare === true));

      if (res.ok && data && data.song && typeof data.song.song === "string") {
        showSong(data.song);
      } else if (res.status === 429) {
        showPlaceholder("Too many requests. Please wait a minute and try again.", true);
      } else {
        const msg = data && typeof data.error === "string" ? data.error : null;
        showPlaceholder(msg || "The music finder couldn't find a song right now. Please try again.", true);
      }
    } catch (err) {
      if (myId !== requestId) return;
      const timedOut = err && err.name === "AbortError";
      showPlaceholder(
        timedOut
          ? "That took too long. Please try again."
          : "Something went wrong. Please check your connection and try again.",
        true
      );
    } finally {
      clearTimeout(timer);
      if (myId === requestId) {
        els.loading.classList.remove("on");
        setBusy(false);
      }
    }
  }

  // ── show a song (DOM only, never innerHTML, so AI text can't inject markup) ──
  /** Renders a song using DOM text only (never innerHTML), then looks for its video. */
  function showSong(song) {
    currentSong = {
      song: String(song.song || ""),
      singer: String(song.singer || ""),
      film: String(song.film || ""),
      year: String(song.year || ""),
      why: String(song.why || ""),
      searchQuery: String(song.searchQuery || `${song.song} ${song.singer}`).slice(0, 150),
    };

    els.name.textContent = currentSong.song;

    els.meta.textContent = "";
    metaParts(currentSong).forEach((part, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.textContent = "·";
        sep.setAttribute("aria-hidden", "true");
        els.meta.appendChild(sep);
      }
      els.meta.appendChild(document.createTextNode(part));
    });

    els.why.textContent = currentSong.why;
    els.why.hidden = !currentSong.why;

    recentSongs.push(currentSong.song);
    recentSongs = recentSongs.slice(-RECENT_LIMIT);

    els.copy.textContent = "Copy details";
    refreshSaveButton();
    els.ytLink.href = ytSearchUrl(currentSong.searchQuery);
    els.info.classList.add("on");

    loadVideo(currentSong, requestId);
  }

  /** Finds an embeddable video for the song; ignores the answer if a newer song replaced it. */
  async function loadVideo(song, forRequest) {
    stopVideo();
    els.ytStatus.textContent = "Finding the recording...";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS);

    try {
      const res = await fetch(`/api/video?q=${encodeURIComponent(song.searchQuery)}`, {
        signal: controller.signal,
      });
      const data = res.ok ? await res.json() : null;
      if (forRequest !== requestId || currentSong !== song) return; // a newer song replaced this one

      const id = data && typeof data.videoId === "string" ? data.videoId : "";
      if (VIDEO_ID.test(id)) {
        const frame = document.createElement("iframe");
        frame.src = `https://www.youtube-nocookie.com/embed/${id}?rel=0`;
        frame.title = `${song.song} - video player`;
        frame.allow = "encrypted-media; picture-in-picture; fullscreen";
        frame.allowFullscreen = true;
        frame.referrerPolicy = "strict-origin-when-cross-origin";
        frame.loading = "lazy";
        els.yt.appendChild(frame);
        els.yt.hidden = false;
        els.ytLink.href = `https://www.youtube.com/watch?v=${id}`;
        els.ytStatus.textContent = "";
      } else {
        els.ytStatus.textContent = "Couldn't find a playable video here. Use the button below to search YouTube.";
      }
    } catch {
      if (forRequest !== requestId || currentSong !== song) return;
      els.ytStatus.textContent = "Couldn't load the player. Use the button below to search YouTube.";
    } finally {
      clearTimeout(timer);
    }
  }

  // ── favourites ──
  /** True when this song is already in favourites. */
  function isSaved(song) {
    return favs.some((f) => favKey(f) === favKey(song));
  }

  /** Syncs the Save button label with favourites. */
  function refreshSaveButton() {
    const saved = currentSong ? isSaved(currentSong) : false;
    els.save.setAttribute("aria-pressed", String(saved));
    els.save.textContent = saved ? "♥ Saved" : "♡ Save";
  }

  /** Adds or removes the current song from favourites. */
  function toggleSave() {
    if (!currentSong) return;
    if (isSaved(currentSong)) {
      favs = favs.filter((f) => favKey(f) !== favKey(currentSong));
    } else {
      favs = [
        {
          song: currentSong.song,
          singer: currentSong.singer,
          film: currentSong.film,
          year: currentSong.year,
          searchQuery: currentSong.searchQuery,
        },
        ...favs,
      ].slice(0, FAV_LIMIT);
    }
    if (!storeFavs(favs)) {
      els.save.textContent = "Can't save here";
      setTimeout(refreshSaveButton, 1500);
    } else {
      refreshSaveButton();
    }
    renderFavs();
  }

  /** Redraws the saved-songs list. */
  function renderFavs() {
    els.favList.textContent = "";
    els.favSection.hidden = favs.length === 0;

    favs.forEach((f) => {
      const li = document.createElement("li");
      li.className = "fav-item";

      const text = document.createElement("div");
      text.className = "fav-text";
      const title = document.createElement("div");
      title.className = "fav-title";
      title.textContent = f.song;
      const sub = document.createElement("div");
      sub.className = "fav-sub";
      sub.textContent = metaParts(f).join(" · ");
      text.append(title, sub);

      const actions = document.createElement("div");
      actions.className = "fav-actions";

      const listen = document.createElement("a");
      listen.className = "mini-btn";
      listen.href = ytSearchUrl(f.searchQuery);
      listen.target = "_blank";
      listen.rel = "noopener noreferrer";
      listen.textContent = "▶ Listen";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "mini-btn";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${f.song} from saved songs`);
      remove.addEventListener("click", () => {
        favs = favs.filter((x) => favKey(x) !== favKey(f));
        storeFavs(favs);
        renderFavs();
        refreshSaveButton();
      });

      actions.append(listen, remove);
      li.append(text, actions);
      els.favList.appendChild(li);
    });
  }

  // ── clear / copy ──
  /** Resets the form and result, and cancels any request still running. */
  function clearAll() {
    requestId++; // invalidates anything still in flight
    if (chatController) chatController.abort();

    els.input.value = "";
    els.chips.querySelectorAll(".mood-chip").forEach((c) => {
      c.classList.remove("selected");
      c.setAttribute("aria-pressed", "false");
    });
    selectedMoods = [];
    recentSongs = [];
    currentSong = null;

    els.info.classList.remove("on");
    els.loading.classList.remove("on");
    els.card.classList.remove("active");
    stopVideo();
    setCare(false);
    showPlaceholder(DEFAULT_PLACEHOLDER, false);

    setBusy(false);
    updateCharCount();
  }

  /** Copies "Song - Singer (Film, Year)" to the clipboard. */
  async function copySong() {
    if (!currentSong) return;
    const line = `${currentSong.song} — ${currentSong.singer || "Unknown singer"} (${currentSong.film || "Unknown film"}, ${currentSong.year || "Unknown year"})`;
    try {
      await navigator.clipboard.writeText(line);
      els.copy.textContent = "Copied!";
    } catch {
      els.copy.textContent = "Couldn't copy";
    }
    setTimeout(() => {
      els.copy.textContent = "Copy details";
    }, 1400);
  }

  // ── wire up ──
  els.submit.addEventListener("click", findSong);
  els.again.addEventListener("click", findSong);
  els.clear.addEventListener("click", clearAll);
  els.save.addEventListener("click", toggleSave);
  els.copy.addEventListener("click", copySong);

  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      findSong();
    }
  });
  els.input.addEventListener("input", () => {
    updateCharCount();
    updateSubmitState();
  });

  renderFavs();
  updateCharCount();
  updateSubmitState();
})();
