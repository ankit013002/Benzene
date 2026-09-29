import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { ApiError } from '../api/client';
import { useAuth } from '../session/AuthContext';

export function useRemote<T>(path: string, select: (payload: unknown) => T | null) {
  const { request, endSession } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    request<unknown>(path)
      .then((payload) => {
        const next = select(payload);
        if (next === null) throw new Error('Benzene returned information in an unexpected format.');
        if (active) setData(next);
      })
      .catch(async (cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 401) {
          await endSession();
          if (active) router.replace('/sign-in');
          return;
        }
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load this information.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [endSession, path, request, select]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await request<unknown>(path);
      const next = select(payload);
      if (next === null) throw new Error('Benzene returned information in an unexpected format.');
      setData(next);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        await endSession();
        router.replace('/sign-in');
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load this information.');
    } finally {
      setLoading(false);
    }
  }, [endSession, path, request, select]);
  return { data, loading, error, reload };
}
