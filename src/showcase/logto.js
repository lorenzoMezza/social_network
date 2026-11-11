// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Showcase mode only (EXPO_PUBLIC_SHOWCASE=1, show-case/tools/ready.sh): metro.config.js puts
// this file in place of '@logto/rn', so the app opens already signed in as a demo person,
// without Logto. The development backend accepts its token only with SHOWCASE=1, and a
// production server refuses that setting. Never part of a release build.
import { createContext, createElement, useContext, useMemo, useState } from 'react';

const SUB = process.env.EXPO_PUBLIC_SHOWCASE_SUB || 'showcase.alex';
const NAME = process.env.EXPO_PUBLIC_SHOWCASE_NAME || 'Alex';
const TOKEN = SUB;
const CLAIMS = { sub: SUB, name: NAME, username: NAME.toLowerCase(), email: null };

export class LogtoClientError extends Error {}
export class LogtoRequestError extends Error {}
export class LogtoNativeClientError extends Error {}
export const Prompt = { Login: 'login', Consent: 'consent', None: 'none' };
export const UserScope = { Email: 'email', Profile: 'profile', Phone: 'phone', CustomData: 'custom_data', Identities: 'identities' };

// Stable functions: the app lists them as effect dependencies
const getAccessToken = async () => TOKEN;
const getIdTokenClaims = async () => CLAIMS;
const getIdToken = async () => null;
const fetchUserInfo = async () => CLAIMS;
const client = {
  isSignInRedirected: async () => false,
  handleSignInCallback: async () => {},
  getAccessToken,
  getIdTokenClaims,
};

export const LogtoContext = createContext({ isAuthenticated: true, setIsAuthenticated: () => {} });

export function LogtoProvider({ children }) {
  const [isAuthenticated, setIsAuthenticated] = useState(true);
  const value = useMemo(() => ({ isAuthenticated, setIsAuthenticated }), [isAuthenticated]);
  return createElement(LogtoContext.Provider, { value }, children);
}

export function useLogto() {
  const { isAuthenticated, setIsAuthenticated } = useContext(LogtoContext);
  return useMemo(() => ({
    isInitialized: true,
    isAuthenticated,
    client,
    getAccessToken,
    getIdTokenClaims,
    getIdToken,
    fetchUserInfo,
    signIn: async () => setIsAuthenticated(true),
    signOut: async () => setIsAuthenticated(false),
  }), [isAuthenticated, setIsAuthenticated]);
}
