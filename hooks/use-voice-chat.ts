"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The Web Speech API types are not part of the standard DOM lib, so we declare
// the minimal surface we rely on here.
type SpeechRecognitionResultLike = {
  0: { transcript: string };
  isFinal: boolean;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
};

type SpeechRecognitionErrorEventLike = {
  error: string;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// After a final transcript arrives in hands-free voice mode, wait briefly for a
// natural pause before auto-submitting so short follow-on phrases stay together.
const AUTO_SUBMIT_SILENCE_MS = 900;

type UseVoiceChatOptions = {
  // Fired on every recognition update (interim + final) so the composer can
  // show a live transcript.
  onTranscript?: (text: string) => void;
  // Fired once an utterance is finalized. In hands-free mode the caller
  // typically submits the message from here.
  onFinalTranscript?: (text: string) => void;
};

export type VoiceChat = {
  isSupported: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  voiceMode: boolean;
  toggleVoiceMode: () => void;
  startListening: () => void;
  stopListening: () => void;
  speak: (text: string, onDone?: () => void) => void;
  cancelSpeech: () => void;
};

export function useVoiceChat(options: UseVoiceChatOptions = {}): VoiceChat {
  const { onTranscript, onFinalTranscript } = options;

  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalTranscriptRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest callbacks in refs so the recognition handlers, which are
  // wired up once, always call the current versions.
  const onTranscriptRef = useRef(onTranscript);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  const voiceModeRef = useRef(voiceMode);
  onTranscriptRef.current = onTranscript;
  onFinalTranscriptRef.current = onFinalTranscript;
  voiceModeRef.current = voiceMode;

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const Ctor = getSpeechRecognitionCtor();
    const synthSupported =
      typeof window !== "undefined" && "speechSynthesis" in window;
    setIsSupported(Boolean(Ctor) && synthSupported);

    if (!Ctor) {
      return;
    }

    const recognition = new Ctor();
    recognition.lang =
      typeof navigator === "undefined"
        ? "en-US"
        : navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const { 0: alternative, isFinal } = event.results[i];
        if (isFinal) {
          final += alternative.transcript;
        } else {
          interim += alternative.transcript;
        }
      }

      if (final) {
        finalTranscriptRef.current =
          `${finalTranscriptRef.current} ${final}`.trim();
      }

      const combined = `${finalTranscriptRef.current} ${interim}`.trim();
      onTranscriptRef.current?.(combined);

      // Debounce: once speech pauses, commit the utterance.
      clearSilenceTimer();
      silenceTimerRef.current = setTimeout(() => {
        const text = finalTranscriptRef.current.trim();
        if (text) {
          onFinalTranscriptRef.current?.(text);
          finalTranscriptRef.current = "";
          // In hands-free mode, stop capturing after the utterance is sent so
          // the mic doesn't pick up the assistant's spoken reply; it reopens
          // once the reply finishes playing.
          if (voiceModeRef.current) {
            try {
              recognition.stop();
            } catch {
              // ignore
            }
          }
        }
      }, AUTO_SUBMIT_SILENCE_MS);
    };

    recognition.onerror = () => {
      // "no-speech"/"aborted" are routine; just let onend handle cleanup.
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      clearSilenceTimer();
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    };
  }, [clearSilenceTimer]);

  const stopListening = useCallback(() => {
    clearSilenceTimer();
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    }
    setIsListening(false);
  }, [clearSilenceTimer]);

  const cancelSpeech = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }, []);

  const startListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      return;
    }
    // Never let the mic capture the assistant's own spoken reply.
    cancelSpeech();
    finalTranscriptRef.current = "";
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      // start() throws if already started; treat as already listening.
      setIsListening(true);
    }
  }, [cancelSpeech]);

  const speak = useCallback((text: string, onDone?: () => void) => {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window) ||
      !text.trim()
    ) {
      onDone?.();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang =
      typeof navigator === "undefined"
        ? "en-US"
        : navigator.language || "en-US";
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      setIsSpeaking(false);
      onDone?.();
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      onDone?.();
    };
    window.speechSynthesis.speak(utterance);
  }, []);

  const toggleVoiceMode = useCallback(() => {
    setVoiceMode((prev) => {
      const next = !prev;
      if (!next) {
        stopListening();
        cancelSpeech();
      }
      return next;
    });
  }, [cancelSpeech, stopListening]);

  // Stop everything when the component using the hook unmounts.
  useEffect(
    () => () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    },
    []
  );

  return {
    cancelSpeech,
    isListening,
    isSpeaking,
    isSupported,
    speak,
    startListening,
    stopListening,
    toggleVoiceMode,
    voiceMode,
  };
}
