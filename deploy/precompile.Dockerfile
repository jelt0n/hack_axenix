ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# The public server runs only prebuilt code, including the JavaParser helper.
RUN python -c "from backend.java_parser import prepare_parser; prepare_parser()"
