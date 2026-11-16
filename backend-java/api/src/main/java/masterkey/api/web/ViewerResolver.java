// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.web;

import jakarta.servlet.http.HttpServletRequest;
import masterkey.api.Limits;
import masterkey.api.people.Accounts;
import masterkey.auth.Claims;
import masterkey.auth.TokenVerifier;
import masterkey.core.ApiError;
import org.jspecify.annotations.Nullable;
import org.springframework.core.MethodParameter;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

/**
 * A {@link Viewer} parameter: {@code Authorization: Bearer <access token>}, verified, the
 * account made on its first request, and the {@code requests} limit counted (API.md, Conventions).
 */
public final class ViewerResolver implements HandlerMethodArgumentResolver {

    private final TokenVerifier tokens;
    private final Accounts accounts;
    private final Limits limits;

    public ViewerResolver(TokenVerifier tokens, Accounts accounts, Limits limits) {
        this.tokens = tokens;
        this.accounts = accounts;
        this.limits = limits;
    }

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return parameter.getParameterType() == Viewer.class;
    }

    @Override
    public Viewer resolveArgument(MethodParameter parameter, @Nullable ModelAndViewContainer container, NativeWebRequest request,
                                  @Nullable WebDataBinderFactory binders) {
        HttpServletRequest http = request.getNativeRequest(HttpServletRequest.class);
        if (http == null) throw ApiError.unauthorized("access token missing, invalid or expired");
        Claims claims = tokens.verify(bearer(http.getHeader("Authorization")));
        Viewer viewer = accounts.viewer(claims, http.getHeader("X-Id-Token"), http.getHeader("X-Profile-Hint"));
        limits.check(viewer.id(), Limits.Action.REQUESTS);
        return viewer;
    }

    static @Nullable String bearer(@Nullable String header) {
        if (header == null || header.length() < 8 || !header.regionMatches(true, 0, "Bearer ", 0, 7)) return null;
        String token = header.substring(7).strip();
        return token.isEmpty() ? null : token;
    }
}
