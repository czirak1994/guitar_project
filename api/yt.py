import os
import time
import yt_dlp

def get_youtube_audio(url: str, output_dir: str) -> dict:
    """
    Extracts the best audio format from a YouTube URL and downloads it.
    Returns a dict with 'filepath' and 'title'.
    Does not use ffmpeg post-processing to avoid system dependencies; 
    relies on native m4a/webm formats.
    """
    # Create output dir if needed
    os.makedirs(output_dir, exist_ok=True)
    
    file_id = f'backing_{int(time.time()*1000)}'
    
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(output_dir, f'{file_id}.%(ext)s'),
        'quiet': True,
        'no_warnings': True,
        'extract_flat': False
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(url, download=True)
            title = info_dict.get('title', 'YouTube Audio')
            ext = info_dict.get('ext', 'm4a')
            
            filepath = os.path.join(output_dir, f"{file_id}.{ext}")
            
            if os.path.exists(filepath):
                return {"filepath": filepath, "title": title}
            else:
                raise Exception("File downloaded but path mismatch")
    except Exception as e:
        print(f"[YT-DLP Error] {e}")
        raise e
