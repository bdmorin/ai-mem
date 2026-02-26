import { useState, useEffect } from 'react';
import { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    // Load initial settings
    fetch(API_ENDPOINTS.SETTINGS)
      .then(res => res.json())
      .then(data => {
        setSettings({
          AI_MEM_MODEL: data.AI_MEM_MODEL || DEFAULT_SETTINGS.AI_MEM_MODEL,
          AI_MEM_CONTEXT_OBSERVATIONS: data.AI_MEM_CONTEXT_OBSERVATIONS || DEFAULT_SETTINGS.AI_MEM_CONTEXT_OBSERVATIONS,
          AI_MEM_WORKER_PORT: data.AI_MEM_WORKER_PORT || DEFAULT_SETTINGS.AI_MEM_WORKER_PORT,
          AI_MEM_WORKER_HOST: data.AI_MEM_WORKER_HOST || DEFAULT_SETTINGS.AI_MEM_WORKER_HOST,

          // AI Provider Configuration
          AI_MEM_PROVIDER: data.AI_MEM_PROVIDER || DEFAULT_SETTINGS.AI_MEM_PROVIDER,
          AI_MEM_GEMINI_API_KEY: data.AI_MEM_GEMINI_API_KEY || DEFAULT_SETTINGS.AI_MEM_GEMINI_API_KEY,
          AI_MEM_GEMINI_MODEL: data.AI_MEM_GEMINI_MODEL || DEFAULT_SETTINGS.AI_MEM_GEMINI_MODEL,
          AI_MEM_GEMINI_RATE_LIMITING_ENABLED: data.AI_MEM_GEMINI_RATE_LIMITING_ENABLED || DEFAULT_SETTINGS.AI_MEM_GEMINI_RATE_LIMITING_ENABLED,

          // OpenRouter Configuration
          AI_MEM_OPENROUTER_API_KEY: data.AI_MEM_OPENROUTER_API_KEY || DEFAULT_SETTINGS.AI_MEM_OPENROUTER_API_KEY,
          AI_MEM_OPENROUTER_MODEL: data.AI_MEM_OPENROUTER_MODEL || DEFAULT_SETTINGS.AI_MEM_OPENROUTER_MODEL,
          AI_MEM_OPENROUTER_SITE_URL: data.AI_MEM_OPENROUTER_SITE_URL || DEFAULT_SETTINGS.AI_MEM_OPENROUTER_SITE_URL,
          AI_MEM_OPENROUTER_APP_NAME: data.AI_MEM_OPENROUTER_APP_NAME || DEFAULT_SETTINGS.AI_MEM_OPENROUTER_APP_NAME,

          // Token Economics Display
          AI_MEM_CONTEXT_SHOW_READ_TOKENS: data.AI_MEM_CONTEXT_SHOW_READ_TOKENS || DEFAULT_SETTINGS.AI_MEM_CONTEXT_SHOW_READ_TOKENS,
          AI_MEM_CONTEXT_SHOW_WORK_TOKENS: data.AI_MEM_CONTEXT_SHOW_WORK_TOKENS || DEFAULT_SETTINGS.AI_MEM_CONTEXT_SHOW_WORK_TOKENS,
          AI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: data.AI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT || DEFAULT_SETTINGS.AI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT,
          AI_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: data.AI_MEM_CONTEXT_SHOW_SAVINGS_PERCENT || DEFAULT_SETTINGS.AI_MEM_CONTEXT_SHOW_SAVINGS_PERCENT,

          // Observation Filtering
          AI_MEM_CONTEXT_OBSERVATION_TYPES: data.AI_MEM_CONTEXT_OBSERVATION_TYPES || DEFAULT_SETTINGS.AI_MEM_CONTEXT_OBSERVATION_TYPES,
          AI_MEM_CONTEXT_OBSERVATION_CONCEPTS: data.AI_MEM_CONTEXT_OBSERVATION_CONCEPTS || DEFAULT_SETTINGS.AI_MEM_CONTEXT_OBSERVATION_CONCEPTS,

          // Display Configuration
          AI_MEM_CONTEXT_FULL_COUNT: data.AI_MEM_CONTEXT_FULL_COUNT || DEFAULT_SETTINGS.AI_MEM_CONTEXT_FULL_COUNT,
          AI_MEM_CONTEXT_FULL_FIELD: data.AI_MEM_CONTEXT_FULL_FIELD || DEFAULT_SETTINGS.AI_MEM_CONTEXT_FULL_FIELD,
          AI_MEM_CONTEXT_SESSION_COUNT: data.AI_MEM_CONTEXT_SESSION_COUNT || DEFAULT_SETTINGS.AI_MEM_CONTEXT_SESSION_COUNT,

          // Feature Toggles
          AI_MEM_CONTEXT_SHOW_LAST_SUMMARY: data.AI_MEM_CONTEXT_SHOW_LAST_SUMMARY || DEFAULT_SETTINGS.AI_MEM_CONTEXT_SHOW_LAST_SUMMARY,
          AI_MEM_CONTEXT_SHOW_LAST_MESSAGE: data.AI_MEM_CONTEXT_SHOW_LAST_MESSAGE || DEFAULT_SETTINGS.AI_MEM_CONTEXT_SHOW_LAST_MESSAGE,
        });
      })
      .catch(error => {
        console.error('Failed to load settings:', error);
      });
  }, []);

  const saveSettings = async (newSettings: Settings) => {
    setIsSaving(true);
    setSaveStatus('Saving...');

    const response = await fetch(API_ENDPOINTS.SETTINGS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    });

    const result = await response.json();

    if (result.success) {
      setSettings(newSettings);
      setSaveStatus('✓ Saved');
      setTimeout(() => setSaveStatus(''), TIMING.SAVE_STATUS_DISPLAY_DURATION_MS);
    } else {
      setSaveStatus(`✗ Error: ${result.error}`);
    }

    setIsSaving(false);
  };

  return { settings, saveSettings, isSaving, saveStatus };
}
