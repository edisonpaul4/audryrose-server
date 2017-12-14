var { BaseModel } = require('../database/base.model');

exports.ProductsModel = new class ProductsModel extends BaseModel {
  constructor(){
    super();
    this.Product = Parse.Object.extend('Product');
    this.ProductVariant = Parse.Object.extend('ProductVariant');
  }

  /**
   * @returns Promise - Array of objects
   * @param base query params
   */
  getProductsByFilters(params) {
    var productsQuery = new Parse.Query(this.Product);
    return this.searchDatabase(params, productsQuery);
  }

  /**
   * @returns Promise - Array of objects
   * @param base query params
   */
  getProductsVariantsByFilters(params) {
    var productsVariantsQuery = new Parse.Query(this.ProductVariant);
    return this.searchDatabase(params, productsVariantsQuery);
  }
}