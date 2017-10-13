exports.ProductsModel = new class ProductsModel {
  constructor(){
    this.Products = Parse.Object.extend('Product');
  }

  /**
   * @returns Promise - Array of objects
   * @param {*} param0
   */
  getProductsByFilters({ includes, page, limit, sort, skip, equal, notEqual, exists, notExists }) {
    var productsQuery = new Parse.Query(this.Products);
    if (includes !== null && typeof includes !== 'undefined')
      includes.map(include => productsQuery.include(include));

    if(equal !== null && typeof equal !== 'undefined')
      equal.map(condition => productsQuery.equalTo(condition.key, condition.value))
      
    if(notEqual !== null && typeof notEqual !== 'undefined')
      notEqual.map(condition => productsQuery.notEqualTo(condition.key, condition.value))
      
    if(exists !== null && typeof exists !== 'undefined')
      exists.map(key => productsQuery.exists(key))

    if(notExists !== null && typeof notExists !== 'undefined')
      notExists.map(key => productsQuery.doesNotExist(key))

    if(limit === null || typeof limit === 'undefined' )
      limit = 100;

    if(skip === null || typeof skip === 'undefined' )
      skip = 0;
      
    return productsQuery
      .limit(limit)
      .skip(skip)
      .find()
      .then(objects => objects.map(object => object.toJSON()));
  }  
}