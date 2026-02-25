import type { IDocumentLoader, LoadResult } from './loader.interface.js';

export interface YoutubeTranscriptItem {
  startMs: string;
  endMs: string;
  startTime: string;
  text: string;
}

export interface YoutubeTranscriptResponse {
  id: string;
  transcript: YoutubeTranscriptItem[];
  transcript_text?: string;
  selected?: Record<string, unknown>;
  languageMenu?: Record<string, unknown>[];
}

export interface YoutubeVideoInfoResponse {
  id: string;
  title?: string;
  description?: string;
  thumbnail?: Array<{ url: string; width: number; height: number }>;
  [key: string]: unknown;
}

export class YoutubeLoader implements IDocumentLoader {
  supports(sourceType: string): boolean {
    return sourceType === 'youtube';
  }

  async load(
    source: string | Buffer,
    _options?: Record<string, unknown>,
  ): Promise<LoadResult> {
    if (typeof source !== 'string') {
      throw new Error(
        'Invalid source for YouTube loader. Expected video ID or URL string.',
      );
    }

    const videoId = this.extractVideoId(source);
    if (!videoId) {
      throw new Error('Could not extract YouTube video ID from source.');
    }

    try {
      const [transcriptResult, videoInfo] = await Promise.all([
        this.fetchTranscript(videoId),
        this.fetchVideoInfo(videoId).catch((err) => {
          console.warn(`Failed to fetch video info for ${videoId}:`, err);
          return null;
        }),
      ]);

      const { transcript, transcript_text } = transcriptResult;

      // Format transcript into a single string if transcript_text is not provided
      const content =
        transcript_text ||
        transcript
          .filter((t) => t.startTime !== undefined && t.text !== undefined)
          .map((t) => `[${t.startTime}] ${t.text}`)
          .join('\n');

      // Extract best thumbnail (highest resolution)
      let bestThumbnailUrl: string | undefined;
      if (videoInfo?.thumbnail && videoInfo.thumbnail.length > 0) {
        const sortedThumbnails = [...videoInfo.thumbnail].sort(
          (a, b) => (b.width || 0) - (a.width || 0),
        );
        bestThumbnailUrl = sortedThumbnails[0]?.url;
      }

      return {
        content,
        title: videoInfo?.title,
        metadata: {
          videoId,
          source: `https://www.youtube.com/watch?v=${videoId}`,
          description: videoInfo?.description,
          image: bestThumbnailUrl,
        },
      };
    } catch (error) {
      throw new Error(
        `YouTube loading failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private extractVideoId(urlOrId: string): string | null {
    // If it's just an ID (11 chars, alphanumeric + _ -)
    if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) {
      return urlOrId;
    }

    // Try to parse as URL
    try {
      const url = new URL(urlOrId);
      if (url.hostname === 'youtu.be') {
        return url.pathname.slice(1);
      }
      if (url.hostname.includes('youtube.com')) {
        return url.searchParams.get('v');
      }
    } catch {
      // Not a valid URL
    }
    return null;
  }

  private async fetchTranscript(videoId: string): Promise<{
    transcript: YoutubeTranscriptItem[];
    transcript_text?: string;
  }> {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) {
      throw new Error('Missing RAPIDAPI_KEY in environment variables.');
    }

    const response = await fetch(
      `https://yt-api.p.rapidapi.com/get_transcript?id=${videoId}`,
      {
        method: 'GET',
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': 'yt-api.p.rapidapi.com',
          'Content-Type': 'application/json',
        },
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `RapidAPI failed with status ${response.status}: ${text}`,
      );
    }

    const data = (await response.json()) as YoutubeTranscriptResponse;

    // Some videos might not have transcripts, handle gracefully
    if (!data || !data.transcript || !Array.isArray(data.transcript)) {
      console.warn(`No transcript found for video ${videoId} or invalid format.`);
      return { transcript: [] };
    }

    return {
      transcript: data.transcript,
      transcript_text: data.transcript_text,
    };
  }

  private async fetchVideoInfo(
    videoId: string,
  ): Promise<YoutubeVideoInfoResponse> {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) {
      throw new Error('Missing RAPIDAPI_KEY in environment variables.');
    }

    const response = await fetch(
      `https://yt-api.p.rapidapi.com/video/info?id=${videoId}`,
      {
        method: 'GET',
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': 'yt-api.p.rapidapi.com',
          'Content-Type': 'application/json',
        },
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `RapidAPI video info failed with status ${response.status}: ${text}`,
      );
    }

    const data = (await response.json()) as YoutubeVideoInfoResponse;

    if (!data || !data.id) {
      throw new Error('Invalid video info response format from RapidAPI.');
    }

    return data;
  }
}
