package com.nebulavault.gateway.filters;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.util.Date;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SessionToHeadersFilterTest {

    /** 64 hex characters, matching the format the filter treats as a hex key. */
    private static final String SECRET =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static byte[] hexToBytes(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < s.length(); i += 2) {
            out[i / 2] = (byte) ((Character.digit(s.charAt(i), 16) << 4)
                    + Character.digit(s.charAt(i + 1), 16));
        }
        return out;
    }

    private static String token(String secret, String sub, String email, String name)
            throws Exception {
        return token(secret, sub, email, name,
                new Date(System.currentTimeMillis() + 60_000), null, JWSAlgorithm.HS256);
    }

    private static String token(String secret, String sub, String email, String name,
            Date expiration, Date notBefore, JWSAlgorithm algorithm) throws Exception {
        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
                .subject(sub)
                .expirationTime(expiration);
        if (notBefore != null) {
            claims.notBeforeTime(notBefore);
        }
        if (email != null) {
            claims.claim("email", email);
        }
        if (name != null) {
            claims.claim("name", name);
        }
        SignedJWT jwt = new SignedJWT(new JWSHeader(algorithm), claims.build());
        jwt.sign(new MACSigner(hexToBytes(secret)));
        return jwt.serialize();
    }

    /** Runs the filter and returns the request as downstream services would see it. */
    private static ServerWebExchange run(MockServerWebExchange exchange) {
        SessionToHeadersFilter filter = new SessionToHeadersFilter(SECRET);
        AtomicReference<ServerWebExchange> forwarded = new AtomicReference<>();
        filter.filter(exchange, ex -> {
            forwarded.set(ex);
            return Mono.empty();
        }).block();
        return forwarded.get();
    }

    private static MockServerWebExchange exchangeWithSession(String token) {
        return MockServerWebExchange.from(
                MockServerHttpRequest.get("/files")
                        .header(HttpHeaders.COOKIE, "session=" + token)
                        .build());
    }

    @Test
    void injectsIdentityHeadersFromAValidToken() throws Exception {
        ServerWebExchange forwarded =
                run(exchangeWithSession(token(SECRET, "user-1", "ada@example.com", "Ada")));

        HttpHeaders headers = forwarded.getRequest().getHeaders();
        assertThat(headers.getFirst("X-User-Id")).isEqualTo("user-1");
        assertThat(headers.getFirst("X-User-AuthSub")).isEqualTo("user-1");
        assertThat(headers.getFirst("X-User-Email")).isEqualTo("ada@example.com");
    }

    /**
     * Regression: a stray semicolon after the guard meant the name was appended
     * twice, which downstream reads as a comma-joined "Ada,Ada".
     */
    @Test
    void addsUserNameExactlyOnce() throws Exception {
        ServerWebExchange forwarded =
                run(exchangeWithSession(token(SECRET, "user-1", "ada@example.com", "Ada")));

        assertThat(forwarded.getRequest().getHeaders().get("X-User-Name"))
                .containsExactly("Ada");
    }

    /** Regression: the same bug added a null name unconditionally. */
    @Test
    void omitsUserNameWhenTheClaimIsAbsent() throws Exception {
        ServerWebExchange forwarded =
                run(exchangeWithSession(token(SECRET, "user-1", "ada@example.com", null)));

        assertThat(forwarded.getRequest().getHeaders().containsKey("X-User-Name")).isFalse();
    }

    @Test
    void stripsClientSuppliedIdentityHeaders() throws Exception {
        MockServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/files")
                        .header(HttpHeaders.COOKIE,
                                "session=" + token(SECRET, "user-1", "ada@example.com", "Ada"))
                        .header("X-User-Id", "attacker")
                        .header("X-User-Email", "attacker@example.com")
                        .build());

        ServerWebExchange forwarded = run(exchange);

        assertThat(forwarded.getRequest().getHeaders().get("X-User-Id"))
                .containsExactly("user-1");
        assertThat(forwarded.getRequest().getHeaders().get("X-User-Email"))
                .containsExactly("ada@example.com");
    }

    @Test
    void rejectsARequestWithNoSessionCookie() {
        MockServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/files").build());

        assertThat(run(exchange)).isNull();
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void rejectsATokenSignedWithADifferentKey() throws Exception {
        String foreign =
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        MockServerWebExchange exchange =
                exchangeWithSession(token(foreign, "user-1", "ada@example.com", "Ada"));

        assertThat(run(exchange)).isNull();
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void rejectsAMalformedToken() {
        MockServerWebExchange exchange = exchangeWithSession("not-a-jwt");

        assertThat(run(exchange)).isNull();
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void rejectsATokenWithoutAnEmailClaim() throws Exception {
        MockServerWebExchange exchange =
                exchangeWithSession(token(SECRET, "user-1", null, "Ada"));

        assertThat(run(exchange)).isNull();
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void rejectsAnExpiredToken() throws Exception {
        String expired = token(SECRET, "user-1", "ada@example.com", "Ada",
                new Date(System.currentTimeMillis() - 1_000), null, JWSAlgorithm.HS256);
        MockServerWebExchange exchange = exchangeWithSession(expired);

        assertThat(run(exchange)).isNull();
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void rejectsATokenThatIsNotValidYet() throws Exception {
        String notYetValid = token(SECRET, "user-1", "ada@example.com", "Ada",
                new Date(System.currentTimeMillis() + 60_000),
                new Date(System.currentTimeMillis() + 60_000), JWSAlgorithm.HS256);
        MockServerWebExchange exchange = exchangeWithSession(notYetValid);

        assertThat(run(exchange)).isNull();
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void rejectsATokenUsingAnUnexpectedAlgorithm() throws Exception {
        String longSecret =
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        String wrongAlgorithm = token(longSecret, "user-1", "ada@example.com", "Ada",
                new Date(System.currentTimeMillis() + 60_000), null, JWSAlgorithm.HS512);
        MockServerWebExchange exchange = exchangeWithSession(wrongAlgorithm);

        assertThat(run(exchange)).isNull();
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void refusesToStartWithAWeakSecret() {
        assertThatThrownBy(() -> new SessionToHeadersFilter("too-short"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("at least 32 characters");
    }
}
