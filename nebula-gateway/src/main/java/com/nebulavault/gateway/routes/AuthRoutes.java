package com.nebulavault.gateway.routes;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AuthRoutes {
    @Bean
    public RouteLocator authRouteLocator(RouteLocatorBuilder builder, @Value("${routes.auth.uri}") String filesUri) {
        return builder.routes()
                // Compatibility for clients that used the original /login
                // gateway path. New clients should use /auth/login.
                .route("login-compatibility", r -> r
                        .path("/login")
                        .filters(f -> f
                                .setPath("/api/auth/login")
                                .addResponseHeader("Nebula-Gateway", "Benzene")
                        ).uri(filesUri)
                )
                .build();
    }
}
