import { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { IconExternalLink, IconRefresh, IconZoomIn, IconZoomOut } from '@tabler/icons-preact';

import { Modal } from '@/components/common';
import { useTranslation } from '@/i18n';

type MediaPreviewModalProps = {
  show: boolean;
  url: string;
  dockAfterClose: boolean;
  onDockAfterCloseChange: (enabled: boolean) => void;
  onClose: () => void;
};

type Point = {
  x: number;
  y: number;
};

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isVideoUrl(url: string) {
  return /\.mp4(?:[?#].*)?$/i.test(url);
}

export function MediaPreviewModal({
  show,
  url,
  dockAfterClose,
  onDockAfterCloseChange,
  onClose,
}: MediaPreviewModalProps) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const dragStartRef = useRef<Point>({ x: 0, y: 0 });
  const dragOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const video = isVideoUrl(url);

  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [url]);

  const zoomTo = useCallback((nextScale: number) => {
    setScale((current) => {
      const next = clamp(nextScale, MIN_ZOOM, MAX_ZOOM);
      if (next <= 1 && current > 1) {
        setOffset({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setScale((current) => {
      const next = clamp(current * factor, MIN_ZOOM, MAX_ZOOM);
      if (next <= 1) {
        setOffset({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const handleWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>) => {
    if (video) return;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.12 : 0.88);
      return;
    }
    if (scale > 1) {
      event.preventDefault();
      setOffset((current) => ({
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      }));
    }
  };

  const handlePointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (video || scale <= 1) return;
    draggingRef.current = true;
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    dragOffsetRef.current = offset;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    event.preventDefault();
    setOffset({
      x: dragOffsetRef.current.x + event.clientX - dragStartRef.current.x,
      y: dragOffsetRef.current.y + event.clientY - dragStartRef.current.y,
    });
  };

  const stopDragging = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleDoubleClick = () => {
    if (video) return;
    if (scale > 1) {
      resetView();
    } else {
      zoomTo(2);
    }
  };

  return (
    <Modal
      title={t('Media View')}
      class="h-[min(92vh,980px)] w-[min(96vw,1480px)] max-w-[96vw] max-h-[92vh]"
      show={show && !!url}
      onClose={onClose}
    >
      <div class="flex min-h-0 grow flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2 border-b border-base-300 pb-2 text-xs">
          {video ? null : (
            <>
              <button class="btn btn-xs" onClick={() => zoomBy(1 / ZOOM_STEP)}>
                <IconZoomOut size={14} />
                {Math.round(scale * 100)}%
              </button>
              <button class="btn btn-xs" onClick={() => zoomBy(ZOOM_STEP)}>
                <IconZoomIn size={14} />
              </button>
              <button class="btn btn-xs" onClick={resetView}>
                <IconRefresh size={14} />
                Reset
              </button>
            </>
          )}
          <a class="btn btn-xs" href={url} target="_blank" rel="noreferrer">
            <IconExternalLink size={14} />
            Open
          </a>
          <label class="label ml-auto cursor-pointer gap-2 py-0">
            <input
              type="checkbox"
              class="toggle toggle-xs"
              checked={dockAfterClose}
              onChange={(event) =>
                onDockAfterCloseChange((event.target as HTMLInputElement).checked)
              }
            />
            <span class="label-text text-xs">Keep mini preview after close</span>
          </label>
        </div>
        <main
          class={`relative min-h-0 grow overflow-hidden rounded-box-half bg-base-200 ${
            video ? '' : scale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
          }`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onDblClick={handleDoubleClick}
        >
          {video ? (
            <video controls class="h-full w-full object-contain" src={url} />
          ) : (
            <img
              class="h-full w-full select-none object-contain"
              style={{
                transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
                transformOrigin: 'center center',
                transition: draggingRef.current ? 'none' : 'transform 120ms ease-out',
              }}
              src={url}
              draggable={false}
            />
          )}
        </main>
      </div>
    </Modal>
  );
}
