// Everything the app asks the client's server for, as hooks.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AgentList,
  CaseRecord,
  CaseStatus,
  FoundCases,
  Inquiry,
  InquiryList,
  InquiryResponse,
  NewInquiryRequest,
  NewRunRequest,
  ReviewDecisionRequest,
  RunResponse,
  SampleList,
  SessionView,
  SignOutResponse,
  SystemStatus,
} from '../../shared/api.ts';

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

function textField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(body, name);
  return typeof value === 'string' ? value : undefined;
}

async function request<Result>(path: string, init?: RequestInit): Promise<Result> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiFailure(0, 'unreachable', 'The desk’s server could not be reached. Check that it is running.');
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = textField(body, 'error') ?? `http_${response.status}`;
    const detail = textField(body, 'detail') ?? `The request failed with status ${response.status}.`;
    throw new ApiFailure(response.status, code, detail);
  }
  return body as Result;
}

function post<Result>(path: string, payload: unknown): Promise<Result> {
  return request<Result>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

// The server answers this when nobody is signed in, or the sign-in could not be renewed.
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiFailure && error.status === 401 && error.code === 'not_signed_in';
}

export const SESSION_KEY = ['session'] as const;

// Who is signed in, or null when nobody is.
export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: async (): Promise<SessionView | null> => {
      try {
        return await request<SessionView>('/api/session');
      } catch (error) {
        if (isSignedOut(error)) {
          return null;
        }
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

// Ends the session here, then sends the browser to the identity provider to end it there too.
export function useSignOut() {
  return useMutation({
    mutationFn: () => post<SignOutResponse>('/auth/logout', {}),
    onSuccess: (answer) => {
      window.location.assign(answer.sign_out_url);
    },
  });
}

function anyRunning(inquiry: Inquiry | undefined): boolean {
  return inquiry?.runs.some((run) => run.state === 'running') ?? false;
}

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => request<SystemStatus>('/api/status'),
    refetchInterval: 10_000,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => request<AgentList>('/api/agents'),
    staleTime: 60_000,
  });
}

export function useSamples() {
  return useQuery({
    queryKey: ['samples'],
    queryFn: () => request<SampleList>('/api/samples'),
    staleTime: Infinity,
  });
}

export function useInquiries() {
  return useQuery({
    queryKey: ['inquiries'],
    queryFn: () => request<InquiryList>('/api/inquiries'),
    refetchInterval: (query) =>
      query.state.data?.inquiries.some((inquiry) => inquiry.runs.some((run) => run.state === 'running')) === true
        ? 1500
        : 15_000,
  });
}

export function useInquiry(id: string | undefined) {
  return useQuery({
    queryKey: ['inquiry', id],
    queryFn: async () => (await request<InquiryResponse>(`/api/inquiries/${encodeURIComponent(id ?? '')}`)).inquiry,
    enabled: id !== undefined,
    refetchInterval: (query) => (anyRunning(query.state.data) ? 1000 : false),
  });
}

export function useSendInquiry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: NewInquiryRequest) => (await post<InquiryResponse>('/api/inquiries', payload)).inquiry,
    onSuccess: (inquiry) => {
      queryClient.setQueryData(['inquiry', inquiry.id], inquiry);
      void queryClient.invalidateQueries({ queryKey: ['inquiries'] });
    },
  });
}

export function useSendAgain(inquiryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: NewRunRequest) =>
      (await post<RunResponse>(`/api/inquiries/${encodeURIComponent(inquiryId)}/runs`, payload)).run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inquiry', inquiryId] });
      void queryClient.invalidateQueries({ queryKey: ['inquiries'] });
    },
  });
}

export function useCases(status: CaseStatus | undefined) {
  return useQuery({
    queryKey: ['cases', status ?? 'all'],
    queryFn: () => request<FoundCases>(status === undefined ? '/api/cases' : `/api/cases?status=${status}`),
    refetchInterval: 5000,
  });
}

export function useCase(caseId: string | undefined) {
  return useQuery({
    queryKey: ['case', caseId],
    queryFn: () => request<CaseRecord>(`/api/cases/${encodeURIComponent(caseId ?? '')}`),
    enabled: caseId !== undefined,
    refetchInterval: 5000,
  });
}

export function useReview(caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewDecisionRequest) => post<unknown>(`/api/cases/${encodeURIComponent(caseId)}/review`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['case', caseId] });
      void queryClient.invalidateQueries({ queryKey: ['cases'] });
    },
  });
}
