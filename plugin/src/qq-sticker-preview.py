"""Decode QQ sticker bytes and render consecutive, labeled PNG frame sheets."""

import base64
from hashlib import sha256
from io import BytesIO
import json
from math import ceil, isfinite, sqrt
import struct
import sys
import warnings
from zlib import crc32

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit(3)

MAX_INPUT_BYTES = 5 * 1024 * 1024
MAX_CANVAS_PIXELS = 1024 * 1024
MAX_DECODED_PIXELS = 16 * 1024 * 1024
FRAMES_PER_SHEET = 16
TILE = 180
CAPTION = 22
FORMATS = {"gif": "GIF", "webp": "WEBP", "png": "PNG", "jpg": "JPEG"}


def gif_sub_blocks(data, offset):
    while offset < len(data):
        size = data[offset]
        offset += 1
        if size == 0:
            return offset
        offset += size
    raise ValueError("Truncated GIF sub-block")


def gif_frame_count(data, width, height):
    flags = data[10]
    offset = 13 + (3 * (2 << (flags & 7)) if flags & 0x80 else 0)
    frames = 0
    while offset < len(data):
        kind = data[offset]
        if kind == 0x3B and offset + 1 == len(data) and frames:
            return frames
        if kind == 0x21:
            offset = gif_sub_blocks(data, offset + 2)
        elif kind == 0x2C:
            left, top, w, h, flags = struct.unpack_from("<HHHHB", data, offset + 1)
            if not w or not h or left + w > width or top + h > height:
                raise ValueError("GIF frame lies outside the logical canvas")
            offset += 10 + (3 * (2 << (flags & 7)) if flags & 0x80 else 0)
            if offset + 1 >= len(data) or not 2 <= data[offset] <= 8 or not data[offset + 1]:
                raise ValueError("Invalid GIF image data")
            offset = gif_sub_blocks(data, offset + 1)
            frames += 1
        else:
            break
    raise ValueError("Invalid GIF block or trailer")


def png_frame_count(data):
    declared = None
    frame_controls = 0
    image_data_started = False
    offset = 8
    source = memoryview(data)
    while offset + 12 <= len(data):
        size, kind = struct.unpack_from(">I4s", data, offset)
        end = offset + size + 12
        if end > len(data):
            raise ValueError("Truncated PNG chunk")
        if crc32(source[offset + 4:end - 4]) != struct.unpack_from(">I", data, end - 4)[0]:
            raise ValueError("Invalid PNG chunk checksum")
        if kind == b"acTL":
            if size != 8 or declared is not None or image_data_started:
                raise ValueError("Invalid APNG animation control")
            declared = struct.unpack_from(">I", data, offset + 8)[0]
        elif kind == b"fcTL":
            if size != 26:
                raise ValueError("Invalid APNG frame control")
            frame_controls += 1
        elif kind == b"IDAT":
            image_data_started = True
        elif kind == b"IEND":
            if end != len(data):
                raise ValueError("Unexpected data after PNG end")
            break
        offset = end
    if (declared is not None and not declared) or (declared or 0) != frame_controls:
        raise ValueError("APNG frame count does not match its frame controls")
    return declared


def check_container(data, extension):
    expected_frames = None
    if extension == "gif" and data.startswith((b"GIF87a", b"GIF89a")) and data.endswith(b";"):
        width, height = struct.unpack_from("<HH", data, 6)
        if len(data) < 14:
            raise ValueError("Truncated GIF header")
        expected_frames = gif_frame_count(data, width, height)
    elif extension == "png" and data.startswith(b"\x89PNG\r\n\x1a\n") and data.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82"):
        width, height = struct.unpack_from(">II", data, 16)
        expected_frames = png_frame_count(data)
    elif extension == "webp" and data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) == 8 + int.from_bytes(data[4:8], "little"):
        if data[12:16] != b"VP8X":
            return
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
    elif extension == "jpg" and data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"):
        return
    else:
        raise ValueError("Invalid sticker container")
    if not 0 < width * height <= MAX_CANVAS_PIXELS:
        raise ValueError("Sticker canvas exceeds the pixel budget")
    return expected_frames


def render_sheet(frames, first_frame):
    if len(frames) == 1 and first_frame == 0 and frames[0][1] is None:
        return frames[0][0]
    columns = ceil(sqrt(len(frames)))
    rows = ceil(len(frames) / columns)
    sheet = Image.new("RGB", (columns * TILE, rows * (TILE + CAPTION)), (242, 245, 248))
    drawing = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=15)
    except TypeError:
        font = ImageFont.load_default()
    for index, (frame, duration) in enumerate(frames):
        x = (index % columns) * TILE
        y = (index // columns) * (TILE + CAPTION)
        sheet.paste(frame, (x + (TILE - frame.width) // 2, y + (TILE - frame.height) // 2), frame)
        timing = "" if duration is None else f"  {duration:g} ms"
        drawing.text((x + TILE / 2, y + TILE + CAPTION / 2), f"{first_frame + index + 1}{timing}",
                     fill=(32, 39, 47), font=font, anchor="mm")
    return sheet


def canonical_frame(frame):
    # Hidden RGB in fully transparent pixels differs between image encoders.
    alpha_mask = frame.getchannel("A").point([0] + [255] * 255)
    clean = Image.new("RGBA", frame.size)
    clean.paste(frame, mask=alpha_mask)
    return clean


def preview(data, extension, max_sheets, max_bytes):
    expected_frames = check_container(data, extension)
    Image.MAX_IMAGE_PIXELS = MAX_CANVAS_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    sheets = []
    shown_frames = 0
    visual_hash = sha256()
    visual_hash.update(b"surfcore-sticker-rgba-v1")
    with Image.open(BytesIO(data), formats=[FORMATS[extension]]) as decoded:
        if decoded.format != FORMATS[extension]:
            raise ValueError("Decoded sticker format does not match its container")
        pixel_count = decoded.width * decoded.height
        first = 1 if decoded.info.get("default_image") else 0
        frame_count = getattr(decoded, "n_frames", 1) - first
        if expected_frames is not None and frame_count != expected_frames:
            raise ValueError("Decoded frame count does not match the image container")
        frame_limit = min(frame_count, max_sheets * FRAMES_PER_SHEET, MAX_DECODED_PIXELS // pixel_count)
        visual_hash.update(struct.pack(">III", decoded.width, decoded.height, frame_count))
        for start in range(0, frame_limit, FRAMES_PER_SHEET):
            frames = []
            for index in range(start, min(start + FRAMES_PER_SHEET, frame_limit)):
                decoded.seek(first + index)
                frame = canonical_frame(decoded.convert("RGBA"))
                visual_hash.update(frame.tobytes())
                duration = decoded.info.get("duration") if frame_count > 1 else None
                if not isinstance(duration, (int, float)) or not isfinite(duration):
                    duration = None
                if frame_count > 1:
                    scale = (TILE - 8) / max(frame.size)
                    size = tuple(max(1, round(side * scale)) for side in frame.size)
                    frame = frame.resize(size, Image.Resampling.LANCZOS)
                frames.append((frame, duration))
            with BytesIO() as output:
                render_sheet(frames, start).save(output, "PNG")
                png = output.getvalue()
            if len(png) > min(max_bytes, MAX_INPUT_BYTES):
                break
            max_bytes -= len(png)
            sheets.append(base64.b64encode(png).decode("ascii"))
            shown_frames += len(frames)
    return {"sheets": sheets, "frameCount": frame_count, "shownFrames": shown_frames,
            "visualHash": visual_hash.hexdigest() if shown_frames == frame_count else None}


def main():
    extension, max_sheets, max_bytes = sys.argv[1:]
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if not data or len(data) > MAX_INPUT_BYTES:
        return
    try:
        print(json.dumps(preview(data, extension, int(max_sheets), int(max_bytes))))
    except (EOFError, OSError, ValueError, struct.error, Image.DecompressionBombError, Image.DecompressionBombWarning):
        sys.exit(4)


if __name__ == "__main__":
    main()
