package com.nebulavault.gateway.filters;

import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Date;

@Component
public class SessionToHeadersFilter implements GatewayFilter, Ordered {

    private final byte[] hmacKey;

    public SessionToHeadersFilter(@Value("${auth.hmacSecret}") String secret) {
        String raw = secret == null ? "" : secret.trim();
        // The auth service refuses to start without a >=32 char AUTH_SECRET;
        // the gateway must hold the same bar or it would happily verify
        // tokens signed with a weak key.
        if (raw.length() < 32) {
            throw new IllegalStateException(
                    "AUTH_SECRET must be at least 32 characters (64 hex chars recommended)");
        }
        if (raw.matches("(?i)^[0-9a-f]{64}$")) {
            this.hmacKey = hexToBytes(raw);
        } else {
            this.hmacKey = raw.getBytes(StandardCharsets.UTF_8);
        }
    }

    private static byte[] hexToBytes(String s) {
        int len = s.length();
        byte[] out = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            out[i / 2] = (byte) ((Character.digit(s.charAt(i), 16) << 4)
                    +  Character.digit(s.charAt(i + 1), 16));
        }
        return out;
    }


    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String cookieHeader = exchange.getRequest().getHeaders().getFirst(HttpHeaders.COOKIE);
        String token = extractCookie(cookieHeader, "session");

        if (token == null) {
            exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
            return exchange.getResponse().setComplete();
        }

        try {
            SignedJWT jwt = SignedJWT.parse(token);
            // The auth service only issues HS256 access tokens. Checking the
            // algorithm before verification prevents accepting a token under
            // a different MAC algorithm if the implementation changes later.
            if (!JWSAlgorithm.HS256.equals(jwt.getHeader().getAlgorithm())) {
                exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
                return exchange.getResponse().setComplete();
            }
            JWSVerifier verifier = new MACVerifier(hmacKey);

            if (!jwt.verify(verifier)) {
                exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
                return exchange.getResponse().setComplete();
            }

            JWTClaimsSet claims = jwt.getJWTClaimsSet();
            Date now = new Date();
            Date expiration = claims.getExpirationTime();
            Date notBefore = claims.getNotBeforeTime();
            // A session without an expiry is not a session we can safely
            // bound. Reject nbf tokens until their validity window begins.
            if (expiration == null || !expiration.after(now)
                    || (notBefore != null && notBefore.after(now))) {
                exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
                return exchange.getResponse().setComplete();
            }
            String sub   = claims.getStringClaim("sub");
            String email = claims.getStringClaim("email");
            String name  = claims.getStringClaim("name");

            if (sub == null || email == null) {
                exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
                return exchange.getResponse().setComplete();
            }

            ServerHttpRequest mutated = exchange.getRequest().mutate()
                    .headers(h -> {
                        h.remove("X-User-AuthSub");
                        h.remove("X-User-Email");
                        h.remove("X-User-Name");
                        h.remove("X-User-Id");
                        h.add("X-User-Id", sub);
                        h.add("X-User-AuthSub", sub);
                        h.add("X-User-Email", email);
                        if (name != null && !name.isBlank()) {
                            h.add("X-User-Name", name);
                        }
                    })
                    .build();

            return chain.filter(exchange.mutate().request(mutated).build());
        } catch (Exception e) {
            exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
            return exchange.getResponse().setComplete();
        }
    }

    private static String extractCookie(String cookieHeader, String name) {
        if (cookieHeader == null) return null;
        return Arrays.stream(cookieHeader.split(";"))
                .map(String::trim)
                .filter(c -> c.startsWith(name + "="))
                .map(c -> c.substring(name.length() + 1))
                .findFirst().orElse(null);
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }
}
