package com.nebulavault.gateway.routes.user;

import com.nebulavault.gateway.filters.SessionToHeadersFilter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class UserRoute {
    @Bean
    public RouteLocator userRouterLocator(
            RouteLocatorBuilder builder,
            @Value("${routes.user.uri}") String userUri,
            SessionToHeadersFilter sessionFilter
    ){
        return builder.routes()
                .route("user-bootstrap", r -> r
                        .path("/user/bootstrap")
                        .filters(f -> f
                                .filter(sessionFilter)
                                .addResponseHeader("Nebula-Gateway", "Benzene"))
                        .uri(userUri)
                )
                .route("user-me", r -> r
                        .path("/user/me")
                        .filters(f -> f
                                .filter(sessionFilter)
                                .addResponseHeader("Nebula-Gateway", "Benzene"))
                        .uri(userUri)
                )
                .build();
    }
}
