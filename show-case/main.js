// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The page as a story told by scrolling: the chapter in the middle of the screen gives the
// colour of the story, the clip on the phone that stays in view (wide screens) and the
// highlighted link of the bar. Clips play only while seen; with reduced motion, on a tap.
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wide = window.matchMedia('(min-width: 900px)');
const story = document.querySelector('.story');
const chapters = [...document.querySelectorAll('.chapter')];
const stageClips = [...document.querySelectorAll('.phone-stage video')];
const navLinks = new Map([...document.querySelectorAll('.chapters-nav a')].map((link) => [link.hash.slice(1), link]));
const bar = document.querySelector('.bar');
const hero = document.querySelector('.hero');
const progress = document.querySelector('.progress span');

const play = (video) => {
  if (reduced) return;
  if (!video.src && video.dataset.src) video.src = video.dataset.src;
  video.play().catch(() => {});
};

// The chapter crossing the middle of the screen
let current = -1;
const setChapter = (index) => {
  if (index < 0 || index === current) return;
  current = index;
  story.dataset.tone = chapters[index].dataset.tone;
  stageClips.forEach((video, i) => {
    video.classList.toggle('is-on', i === index);
    if (i === index && wide.matches) play(video);
    else video.pause();
  });
  // The bar names fewer places than there are chapters: the last one passed stays lit
  let lit = null;
  for (let i = index; i >= 0 && !lit; i--) lit = navLinks.get(chapters[i].id) ?? null;
  for (const link of navLinks.values()) link.setAttribute('aria-current', String(link === lit));
};
const chapterWatcher = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) setChapter(chapters.indexOf(entry.target));
}, { rootMargin: '-45% 0px -45% 0px' });
chapters.forEach((chapter) => chapterWatcher.observe(chapter));

// Past the story (engineering, privacy, about): the phone stops, their link lights
for (const section of document.querySelectorAll('main > section:not(.story)')) {
  new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    for (const video of stageClips) video.pause();
    current = -1;
    const own = navLinks.get(section.id) ?? null;
    if (own || section.id === 'about') for (const link of navLinks.values()) link.setAttribute('aria-current', String(link === own));
  }, { rootMargin: '-45% 0px -45% 0px' }).observe(section);
}

// Every other clip (the hero, the phones of narrow screens): while on screen
const loose = [...document.querySelectorAll('.phone-hero video, .phone-inline video')];
if (reduced) {
  for (const video of loose) video.controls = true;
  for (const video of stageClips) video.src = video.dataset.src;
} else {
  const clipWatcher = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting && target.offsetParent !== null) play(target);
      else target.pause();
    }
  }, { threshold: 0.4 });
  loose.forEach((video) => clipWatcher.observe(video));
}

// The bar frosts once past the sky; the thin line on top tells how far the story is read
const onScroll = () => {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
  bar.classList.toggle('is-scrolled', window.scrollY > hero.offsetHeight - 80);
};
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll);
onScroll();

// Switching between wide and narrow while reading (a tablet turned): the right clips play
wide.addEventListener('change', () => {
  const index = current;
  current = -1;
  setChapter(Math.max(0, index));
});

// The app itself opens on its own page (demo/), which needs a web server: opened as a file
// (file://) the link would only list a folder, so it goes to the local one (make site)
if (location.protocol === 'file:') {
  for (const link of document.querySelectorAll('[data-try]')) link.href = 'http://localhost:8099/demo/';
}
