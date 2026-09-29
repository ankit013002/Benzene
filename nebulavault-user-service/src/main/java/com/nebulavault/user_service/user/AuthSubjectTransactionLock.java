package com.nebulavault.user_service.user;

import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

@Component
public class AuthSubjectTransactionLock {
    private static final String LOCK_SQL =
            "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))";

    private final JdbcTemplate jdbcTemplate;

    public AuthSubjectTransactionLock(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void lock(String authSub) {
        jdbcTemplate.execute((ConnectionCallback<Void>) connection -> {
            try (PreparedStatement statement = connection.prepareStatement(LOCK_SQL)) {
                statement.setString(1, authSub);
                if (!statement.execute()) {
                    throw new SQLException("PostgreSQL did not return the advisory-lock result");
                }
                try (ResultSet ignored = statement.getResultSet()) {
                    // JDBC can execute PostgreSQL's void-returning lock without Hibernate mapping it.
                }
            }
            return null;
        });
    }
}
