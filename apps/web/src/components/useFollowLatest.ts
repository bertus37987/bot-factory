import { useLayoutEffect, useRef, useState } from "react";

export function useFollowLatest() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const follow = () => {
      if (followRef.current && viewport.clientHeight) viewport.scrollTop = viewport.scrollHeight;
    };
    const onScroll = () => {
      if (!viewport.clientHeight) return;
      followRef.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 56;
      setFollowing(followRef.current);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    follow();
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }, []);

  const jumpToLatest = () => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      viewport.focus({ preventScroll: true });
    }
    followRef.current = true;
    setFollowing(true);
  };

  return { viewportRef, contentRef, following, jumpToLatest };
}
