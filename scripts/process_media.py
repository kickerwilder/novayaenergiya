#!/usr/bin/env python3
"""Обработка фото и видео владельца в img/. Исходники остаются в папке с фото и в репозиторий не попадают.

Запуск из корня репозитория:
    python scripts/process_media.py [папка_с_исходниками] [--only файл ...]
        папка по умолчанию: ..\\photos рядом с репозиторием;
        --only: обработать только указанные файлы (имя исходника или результата, например scene-pair.jpg);
        og.jpg (из scene-pair.jpg) пересобирается только если он назван в --only или режим --only не задан.

Нужны Pillow (pip install Pillow) и, для видео, ffmpeg. Скрипт ищет ffmpeg в PATH, затем в пакете
imageio-ffmpeg (pip install imageio-ffmpeg, лучше во временное окружение вне репозитория). Если ffmpeg
нет, видео копируется как есть, а в отчёте будет его вес. Недостающие исходники пропускаются: для них
остаются прежние файлы. Повторный запуск даёт тот же результат.

Файлы-исходники: hero.mp4, black-station.jpg, black-cabinet.jpg, white-station.jpg, scene-house.jpg,
scene-room.jpg, scene-pair.jpg, diagram-black-box.jpg, diagram-black-cabinet.jpg, diagram-white-4.jpg,
diagram-white-5.jpg.
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Не найден Pillow: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "img"

# (исходник, результат, ширина, качество, предел КБ или None)
PHOTOS = [
    ("black-station.jpg", "photo-black.jpg", 1200, 82, 200),
    ("black-cabinet.jpg", "photo-cabinet.jpg", 1200, 82, 200),
    ("white-station.jpg", "photo-white.jpg", 1200, 82, 200),
    ("scene-house.jpg", "scene-house.jpg", 1200, 82, 150),
    ("scene-room.jpg", "scene-room.jpg", 1200, 82, 150),
    ("scene-pair.jpg", "scene-pair.jpg", 1200, 82, 150),
    ("diagram-black-box.jpg", "diagram-black-box.jpg", 900, 85, None),
    ("diagram-black-cabinet.jpg", "diagram-black-cabinet.jpg", 900, 85, None),
    ("diagram-white-4.jpg", "diagram-white-4.jpg", 900, 85, None),
    ("diagram-white-5.jpg", "diagram-white-5.jpg", 900, 85, None),
]
VIDEO_LIMIT_MB = 2.0
report = []


def kb(p):
    return p.stat().st_size / 1024


def save_jpeg(im, dst, q, limit_kb, progressive=True):
    """Сохраняет JPEG; если задан предел веса, снижает качество шагом 2 до q=60."""
    while True:
        im.save(dst, "JPEG", quality=q, optimize=True, progressive=progressive)
        if not limit_kb or kb(dst) <= limit_kb or q <= 60:
            return q
        q -= 2


def process_photo(src, dst_name, width, q, limit_kb):
    im = Image.open(src)
    im.load()
    im = im.convert("RGB")
    if im.width != width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    dst = IMG / dst_name
    used = save_jpeg(im, dst, q, limit_kb)
    note = "" if not limit_kb or kb(dst) <= limit_kb else "  ВЫШЕ ПРЕДЕЛА %d КБ" % limit_kb
    report.append("%-26s %4dx%-4d %7.0f КБ  q=%d%s" % (dst_name, im.width, im.height, kb(dst), used, note))
    return im


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def probe(ffmpeg, src):
    out = subprocess.run([ffmpeg, "-hide_banner", "-i", str(src)], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
    size = re.search(r"Video:.*?,\s(\d{2,5})x(\d{2,5})", out)
    d = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3)) if dur else None
    return d, (int(size.group(1)), int(size.group(2))) if size else None


def process_video(src):
    dst = IMG / "hero.mp4"
    poster = IMG / "hero-poster.jpg"
    ff = find_ffmpeg()
    if not ff:
        shutil.copyfile(src, dst)
        report.append("hero.mp4: ffmpeg не найден, видео скопировано как есть, %.2f МБ; постер не создан" % (kb(dst) / 1024))
        return
    dur, wh = probe(ff, src)
    crf = 26
    while True:
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-an",
               "-vf", "scale=1280:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)]
        subprocess.run(cmd, check=True)
        if kb(dst) / 1024 <= VIDEO_LIMIT_MB or crf >= 34:
            break
        crf += 2
    d2, wh2 = probe(ff, dst)
    note = "" if kb(dst) / 1024 <= VIDEO_LIMIT_MB else "  ВЫШЕ ПРЕДЕЛА %.0f МБ" % VIDEO_LIMIT_MB
    report.append("hero.mp4  исходник %s, %s с -> %s, %.1f с, %.2f МБ, crf=%d%s" % (wh, "%.1f" % dur if dur else "?", wh2, d2 or 0, kb(dst) / 1024, crf, note))
    # постер: кадр около 4-й секунды (для короткого ролика середина)
    t = 4.0 if (d2 or 0) > 4.5 else max(0.0, (d2 or 0) / 2)
    with tempfile.TemporaryDirectory() as tmp:
        frame = Path(tmp) / "f.png"
        subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-ss", "%.2f" % t, "-i", str(dst), "-frames:v", "1",
                        "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720", str(frame)], check=True)
        im = Image.open(frame).convert("RGB")
    save_jpeg(im, poster, 82, None)
    report.append("hero-poster.jpg  кадр на %.1f с, %dx%d, %.0f КБ" % (t, im.width, im.height, kb(poster)))


def main():
    args = sys.argv[1:]
    only = None
    if "--only" in args:
        i = args.index("--only")
        only = set(args[i + 1 :])
        args = args[:i]
        if not only:
            sys.exit("После --only укажите имена файлов")
    src_dir = Path(args[0]) if args else ROOT.parent / "photos"
    if not src_dir.is_dir():
        sys.exit("Нет папки с исходниками: %s" % src_dir)
    IMG.mkdir(exist_ok=True)
    missing = []
    for src_name, dst_name, width, q, limit in PHOTOS:
        if only is not None and src_name not in only and dst_name not in only:
            continue
        src = src_dir / src_name
        if not src.is_file():
            missing.append(str(src))
            continue
        im = process_photo(src, dst_name, width, q, limit)
        if src_name == "scene-pair.jpg" and (only is None or "og.jpg" in only):  # картинка для ссылок в мессенджерах: 1200x630, обрезка по центру
            top = max(0, (im.height - 630) // 2)
            og = im.crop((0, top, 1200, top + 630)) if im.width == 1200 else im.resize((1200, 630), Image.LANCZOS)
            save_jpeg(og, IMG / "og.jpg", 85, None)
            report.append("%-26s %4dx%-4d %7.0f КБ  q=85 (из scene-pair, обрезка по центру)" % ("og.jpg", 1200, 630, kb(IMG / "og.jpg")))
    video = src_dir / "hero.mp4"
    if only is not None and "hero.mp4" not in only and "hero-poster.jpg" not in only:
        pass
    elif video.is_file():
        process_video(video)
    else:
        missing.append(str(video))
    print("\n".join(report))
    if missing:
        print("\nНЕ НАЙДЕНЫ исходники (прежние файлы оставлены): " + ", ".join(missing))


if __name__ == "__main__":
    main()
