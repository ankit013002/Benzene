package com.nebulavault.user_service.user;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AuthSubjectTransactionLockTest {
    @Test
    void executesTheAdvisoryLockThroughJdbcWithoutMappingPostgresVoid() throws Exception {
        JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
        AuthSubjectTransactionLock subjectLock = new AuthSubjectTransactionLock(jdbcTemplate);
        Connection connection = mock(Connection.class);
        PreparedStatement statement = mock(PreparedStatement.class);
        ResultSet resultSet = mock(ResultSet.class);
        when(connection.prepareStatement(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))"
        )).thenReturn(statement);
        when(statement.execute()).thenReturn(true);
        when(statement.getResultSet()).thenReturn(resultSet);

        subjectLock.lock("auth-sub");

        org.mockito.ArgumentCaptor<ConnectionCallback<Void>> callbackCaptor =
                org.mockito.ArgumentCaptor.forClass(ConnectionCallback.class);
        verify(jdbcTemplate).execute(callbackCaptor.capture());
        callbackCaptor.getValue().doInConnection(connection);
        verify(statement).setString(1, "auth-sub");
        verify(statement).execute();
        verify(resultSet).close();
    }
}
