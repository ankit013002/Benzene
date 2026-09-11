package com.nebulavault.gateway.filters;

import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.net.InetAddress;
import java.net.InetSocketAddress;

/**
 * Binds the agent request's client IP to a header owned by this gateway.
 * Forwarded headers are deliberately ignored because the control plane trusts
 * this value only after the request has crossed the gateway boundary.
 */
@Component
public final class ClientIpHeaderFilter implements GatewayFilter {

    public static final String CLIENT_IP_HEADER = "X-Benzene-Client-Ip";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        InetSocketAddress remoteAddress = exchange.getRequest().getRemoteAddress();
        ServerHttpRequest mutated = exchange.getRequest().mutate()
                .headers(headers -> {
                    headers.remove(CLIENT_IP_HEADER);
                    if (remoteAddress == null) return;

                    InetAddress address = remoteAddress.getAddress();
                    if (address != null) {
                        headers.add(CLIENT_IP_HEADER, address.getHostAddress());
                    }
                })
                .build();

        return chain.filter(exchange.mutate().request(mutated).build());
    }
}
