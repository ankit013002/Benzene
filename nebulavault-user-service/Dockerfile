FROM maven:3.9-eclipse-temurin-21 AS build

WORKDIR /app
COPY pom.xml ./
COPY src ./src
RUN mvn -B -ntp -DskipTests package

FROM eclipse-temurin:21-jre

WORKDIR /app
RUN groupadd --system benzene && useradd --system --gid benzene --no-create-home benzene
COPY --from=build /app/target/*.jar /app/app.jar
RUN chown benzene:benzene /app/app.jar

USER benzene
EXPOSE 8082
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
