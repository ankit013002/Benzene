package com.nebulavault.gateway.filters;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class ClientIpHeaderFilterTest {

    private static ServerWebExchange run(MockServerWebExchange exchange) {
        ClientIpHeaderFilter filter = new ClientIpHeaderFilter();
        AtomicReference<ServerWebExchange> forwarded = new AtomicReference<>();
        filter.filter(exchange, forwardedExchange -> {
            forwarded.set(forwardedExchange);
            return Mono.empty();
        }).block();
        return forwarded.get();
    }

    @Test
    void replacesASpoofedClientHeaderWithTheObservedRemoteAddress() {
        MockServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/agent/enroll")
                        .header(ClientIpHeaderFilter.CLIENT_IP_HEADER, "203.0.113.99")
                        .remoteAddress(new InetSocketAddress("198.51.100.7", 43210))
                        .build());

        ServerWebExchange forwarded = run(exchange);

        assertThat(forwarded.getRequest().getHeaders()
                .getFirst(ClientIpHeaderFilter.CLIENT_IP_HEADER))
                .isEqualTo("198.51.100.7");
    }

    @Test
    void propagatesTheObservedRemoteAddressWhenNoClientHeaderWasProvided() {
        MockServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/agent/heartbeat")
                        .remoteAddress(new InetSocketAddress("192.0.2.44", 43210))
                        .build());

        ServerWebExchange forwarded = run(exchange);

        assertThat(forwarded.getRequest().getHeaders()
                .getFirst(ClientIpHeaderFilter.CLIENT_IP_HEADER))
                .isEqualTo("192.0.2.44");
    }

    @Test
    void removesAClientHeaderWhenTheRemoteAddressIsUnavailable() {
        MockServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/agent/heartbeat")
                        .header(ClientIpHeaderFilter.CLIENT_IP_HEADER, "203.0.113.99")
                        .build());

        ServerWebExchange forwarded = run(exchange);

        HttpHeaders headers = forwarded.getRequest().getHeaders();
        assertThat(headers.containsKey(ClientIpHeaderFilter.CLIENT_IP_HEADER)).isFalse();
    }
}
